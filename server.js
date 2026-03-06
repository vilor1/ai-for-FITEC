const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE DIRETÓRIOS ---
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const MODEL_PATH = path.join(DATA_DIR, "model.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);

// --- UTILITÁRIOS DE DADOS ---
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
        .replace(/[^\w\s]/g, "") // Remove pontuação
        .split(/\s+/)
        .filter(t => t.length > 0);
}

// --- MOTOR DE BUSCA (SCRAPER COM FALLBACK) ---
async function pesquisarWeb(query) {
    const instancias = [
        'searx.be', 'priv.au', 'searx.work', 'search.mdn.social', 
        'searx.fyi', 'searx.run', 'search.disroot.org', 'searx.mx',
        'searx.ch', 'search.bus-hit.me', 'searx.northboot.xyz', 
        'searx.tiekoetter.com', 'searx.sethforprivacy.com',
        'searx.prvcy.eu', 'search.ononoki.org', 'searx.oakhome.net',
        'searx.daetaluz.eu', 'searx.stuehmer.dk', 'searx.varnish.host',
        'timdorr.com', 'searx.xyz', 'search.privacytools.io'
    ];

    for (const host of instancias) {
        try {
            console.log(`[Busca] Tentando instância: ${host}`);
            const resultado = await new Promise((resolve, reject) => {
                const options = {
                    hostname: host,
                    path: `/search?q=${encodeURIComponent(query)}&format=json`,
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Accept': 'application/json'
                    }
                };

                const req = https.get(options, res => {
                    let data = "";
                    res.on("data", chunk => data += chunk);
                    res.on("end", () => {
                        if (res.statusCode !== 200) return reject(`Status ${res.statusCode}`);
                        try {
                            const json = JSON.parse(data);
                            if (json.results && json.results.length > 0) {
                                // Pega o snippet do primeiro resultado e limpa tags HTML
                                const cleanText = json.results[0].content.replace(/<[^>]+>/g, "");
                                resolve(cleanText);
                            } else {
                                reject("Sem resultados");
                            }
                        } catch (e) { reject("Erro no Parse JSON"); }
                    });
                });

                req.on("error", (err) => reject(err.message));
                req.setTimeout(3500, () => { req.destroy(); reject("Timeout"); });
            });

            return resultado.slice(0, 600); // Sucesso! Retorna o texto.

        } catch (erro) {
            console.log(`[Falha] ${host}: ${erro}`);
            continue; // Tenta a próxima instância da lista
        }
    }
    return "Não foi possível encontrar uma resposta em tempo real nos servidores de busca. Tente me treinar manualmente.";
}

// --- LÓGICA DA IA ---
function prever(treinamento, frase) {
    if (!treinamento || treinamento.length === 0) return { intencao: "desconhecido", confianca: 0 };
    
    const tokensUsuario = tokenizar(frase);
    let melhorCat = "desconhecido";
    let maxMatches = 0;

    treinamento.forEach(ex => {
        const tokensEx = tokenizar(ex.frase);
        const matches = tokensUsuario.filter(t => tokensEx.includes(t)).length;
        if (matches > maxMatches) {
            maxMatches = matches;
            melhorCat = ex.categoria;
        }
    });

    const confianca = maxMatches > 0 ? ((maxMatches / tokensUsuario.length) * 100).toFixed(2) : 0;
    return { intencao: melhorCat, confianca: parseFloat(confianca) };
}

// --- SERVIDOR HTTP ---
const server = http.createServer((req, res) => {
    // Rota: Frontend (Arquivos Estáticos)
    if (req.method === "GET" && !req.url.startsWith("/api")) {
        const file = req.url === "/" ? "index.html" : req.url;
        const filePath = path.join(PUBLIC_DIR, file);
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end("Erro 404: Verifique se o index.html esta na pasta /public");
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(data);
        });
        return;
    }

    // Rota API: Treinar
    if (req.method === "POST" && req.url === "/api/train") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} });
                
                modelo.treinamento.push({ frase: data.frase, categoria: data.categoria });
                if (data.resposta) {
                    if (!modelo.respostas[data.categoria]) modelo.respostas[data.categoria] = {};
                    modelo.respostas[data.categoria]["__default"] = data.resposta;
                }
                
                salvarJSON(MODEL_PATH, modelo);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "Treinado" }));
            } catch (e) {
                res.writeHead(400); res.end("Erro no JSON de treino");
            }
        });
    }

    // Rota API: Testar / Perguntar
    if (req.method === "POST" && req.url === "/api/test") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", async () => {
            try {
                const { frase, modo } = JSON.parse(body);
                const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} });
                
                const pred = prever(modelo.treinamento, frase);
                
                if (modo === "resposta") {
                    // Se a confiança for menor que 60% ou não houver resposta salva, busca na Web
                    if (pred.confianca < 60 || !modelo.respostas[pred.intencao]) {
                        pred.resposta = await pesquisarWeb(frase);
                    } else {
                        pred.resposta = modelo.respostas[pred.intencao]["__default"];
                    }
                }
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(pred));
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: "Erro interno no processamento" }));
            }
        });
    }
});

server.listen(PORT, () => {
    console.log(`\n🚀 IA Engine Online!`);
    console.log(`🔗 Link: http://localhost:${PORT}`);
    console.log(`📁 Banco de dados em: ${MODEL_PATH}\n`);
});
