const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// Configuração de Diretórios e Arquivos
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);

const MODEL_PATH = path.join(DATA_DIR, "model.json");

// ====== UTILIDADES ======
function carregarJSON(file, defaultObj) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaultObj, null, 2));
        return defaultObj;
    }
    try {
        return JSON.parse(fs.readFileSync(file));
    } catch (e) {
        return defaultObj;
    }
}

function salvarJSON(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function tokenizar(texto) {
    return texto.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove acentos
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(t => t.length > 0);
}

// ====== LÓGICA DA IA ======
function prever(treinamento, frase) {
    if (!treinamento || treinamento.length === 0) return { intencao: "desconhecido", confianca: 0 };
    
    const tokensAlvo = tokenizar(frase);
    let melhorCat = "desconhecido";
    let maxPontos = 0;

    treinamento.forEach(ex => {
        const tokensEx = tokenizar(ex.frase);
        const pontos = tokensAlvo.filter(t => tokensEx.includes(t)).length;
        if (pontos > maxPontos) {
            maxPontos = pontos;
            melhorCat = ex.categoria;
        }
    });

    // Cálculo simples de confiança baseado na quantidade de palavras que batem
    const confianca = maxPontos > 0 ? Math.min((maxPontos / tokensAlvo.length) * 100, 100).toFixed(2) : 0;
    
    return { intencao: melhorCat, confianca };
}

// ====== MOTOR DE BUSCA (ASK.COM SCRAPER) ======
async function pesquisarWeb(query) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'www.ask.com',
            path: `/web?q=${encodeURIComponent(query)}`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'pt-BR,pt;q=0.9'
            }
        };

        const req = https.get(options, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                // Regex para capturar o "Abstract" ou "Snippet" dos resultados
                // Tenta encontrar parágrafos de descrição ou spans com texto longo
                const regexSnippet = /<p class="[^"]*abstract[^"]*">([\s\S]*?)<\/p>|<div class="[^"]*snippet[^"]*">([\s\S]*?)<\/div>|<span>([^<]{60,300})<\/span>/gi;
                
                let match;
                let snippets = [];
                
                while ((match = regexSnippet.exec(data)) !== null) {
                    let texto = (match[1] || match[2] || match[3]).replace(/<[^>]+>/g, "").trim();
                    if (texto.length > 40) snippets.push(texto);
                }

                if (snippets.length > 0) {
                    resolve(snippets[0]); // Retorna o primeiro resumo relevante
                } else {
                    resolve("Não encontrei uma resposta direta na internet para isso.");
                }
            });
        });

        req.on("error", () => resolve("Erro de conexão ao buscar na web."));
        req.setTimeout(6000, () => { req.destroy(); resolve("A busca na internet demorou demais."); });
    });
}

// ====== LÓGICA DE DECISÃO ======
async function obterResposta(modelo, frase, pred) {
    // Se a IA tiver confiança alta (> 50%) e houver resposta treinada
    if (parseFloat(pred.confianca) >= 50 && modelo.respostas && modelo.respostas[pred.intencao]) {
        return modelo.respostas[pred.intencao]["__default"] || "Intenção detectada, mas sem resposta definida.";
    }

    // Caso contrário, busca na internet
    console.log(`[Busca] Baixa confiança (${pred.confianca}%). Pesquisando: "${frase}"`);
    return await pesquisarWeb(frase);
}

// ====== SERVIDOR HTTP ======
const server = http.createServer((req, res) => {
    // Rota Frontend: Serve o index.html da pasta /public
    if (req.method === "GET" && !req.url.startsWith("/api")) {
        let file = req.url === "/" ? "index.html" : req.url;
        const filePath = path.join(PUBLIC_DIR, file);
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end("Arquivo nao encontrado. Certifique-se que o index.html esta na pasta /public");
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(data);
        });
        return;
    }

    // API: Treinar
    if (req.method === "POST" && req.url === "/api/train") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { frase, categoria, resposta } = JSON.parse(body);
                const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} });
                
                modelo.treinamento.push({ frase, categoria });
                if (resposta) {
                    if (!modelo.respostas[categoria]) modelo.respostas[categoria] = {};
                    modelo.respostas[categoria]["__default"] = resposta;
                }
                
                salvarJSON(MODEL_PATH, modelo);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "Treinado" }));
            } catch (e) {
                res.writeHead(400); res.end("Erro no JSON");
            }
        });
    }

    // API: Testar / Perguntar
    if (req.method === "POST" && req.url === "/api/test") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                const { frase, modo } = JSON.parse(body);
                const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} });
                
                const pred = prever(modelo.treinamento, frase);
                
                if (modo === "resposta") {
                    pred.resposta = await obterResposta(modelo, frase, pred);
                }
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(pred));
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: "Erro interno" }));
            }
        });
    }
});

server.listen(PORT, () => {
    console.log(`\n=========================================`);
    console.log(`🧠 IA ENGINE AVANÇADA - ONLINE`);
    console.log(`🔗 URL: http://localhost:${PORT}`);
    console.log(`=========================================\n`);
});
