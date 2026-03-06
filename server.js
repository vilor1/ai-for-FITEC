const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const ddg = require('ddg');

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
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(t => t.length > 0);
}

// --- PESQUISA WEB E AUTO-APRENDIZADO ---
async function pesquisarEAPRENDER(query, modelo) {
    return new Promise((resolve) => {
        ddg.query(query, (err, data) => {
            let respostaFinal = "Não encontrei um resumo sobre isso. Pode me ensinar?";

            if (!err && data) {
                if (data.AbstractText) respostaFinal = data.AbstractText;
                else if (data.Definition) respostaFinal = data.Definition;
            }

            // LÓGICA DE AUTO-APRENDIZADO
            // Se a resposta for válida, a IA cria uma nova categoria baseada na busca
            if (respostaFinal !== "Não encontrei um resumo sobre isso. Pode me ensinar?") {
                const categoriaNova = "web_aprendizado_" + Date.now();
                modelo.treinamento.push({ frase: query, categoria: categoriaNova });
                if (!modelo.respostas[categoriaNova]) modelo.respostas[categoriaNova] = {};
                modelo.respostas[categoriaNova]["__default"] = respostaFinal;
                
                salvarJSON(MODEL_PATH, modelo);
                console.log(`[Aprendizado] IA aprendeu sobre: ${query}`);
            }

            resolve(respostaFinal);
        });
    });
}

// --- LÓGICA DA IA (CLASSIFICADOR) ---
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
    // Servir HTML Estático
    if (req.method === "GET" && !req.url.startsWith("/api")) {
        const file = req.url === "/" ? "index.html" : req.url;
        const filePath = path.join(PUBLIC_DIR, file);
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end("Erro: Coloque o index.html na pasta /public");
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
        req.on("data", c => body += c);
        req.on("end", () => {
            try {
                const d = JSON.parse(body);
                const m = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} });
                m.treinamento.push({ frase: d.frase, categoria: d.categoria });
                if (d.resposta) {
                    if (!m.respostas[d.categoria]) m.respostas[d.categoria] = {};
                    m.respostas[d.categoria]["__default"] = d.resposta;
                }
                salvarJSON(MODEL_PATH, m);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "ok" }));
            } catch (e) { res.writeHead(400); res.end("Erro"); }
        });
    }

    // API: Testar / Perguntar
    if (req.method === "POST" && req.url === "/api/test") {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", async () => {
            try {
                const { frase, modo } = JSON.parse(body);
                const m = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} });
                const pred = prever(m.treinamento, frase);

                if (modo === "resposta") {
                    // Se não tiver certeza absoluta (>75%), busca na Web e APRENDE
                    if (pred.confianca < 75 || !m.respostas[pred.intencao]) {
                        pred.resposta = await pesquisarEAPRENDER(frase, m);
                    } else {
                        pred.resposta = m.respostas[pred.intencao]["__default"];
                    }
                }
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(pred));
            } catch (e) { res.writeHead(500); res.end("Erro"); }
        });
    }
});

server.listen(PORT, () => {
    console.log(`\n====================================`);
    console.log(`🧠 IA COM AUTO-APRENDIZADO ATIVO`);
    console.log(`🚀 Rodando em: http://localhost:${PORT}`);
    console.log(`====================================\n`);
});
