const http = require("http")
const https = require("https")
const fs = require("fs")
const path = require("path")

const PORT = process.env.PORT || 3000

// Configuração de Diretórios e Arquivos
const DATA_DIR = path.join(__dirname, "data")
const PUBLIC_DIR = path.join(__dirname, "public")

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR)

const MODEL_PATH = path.join(DATA_DIR, "model.json")

// ====== UTILIDADES ======
function carregarJSON(file, defaultObj) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaultObj, null, 2))
        return defaultObj
    }
    try {
        return JSON.parse(fs.readFileSync(file))
    } catch (e) {
        return defaultObj
    }
}

function salvarJSON(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2))
}

function tokenizar(texto) {
    return texto.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove acentos
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(t => t.length > 0)
}

function sigmoid(x) {
    return 1 / (1 + Math.exp(-x))
}

// ====== MODELO IA ======
function construirIA(treinamento) {
    const palavras = [...new Set(treinamento.flatMap(t => tokenizar(t.frase)))]
    const vetorizar = frase => {
        const tokens = tokenizar(frase)
        return palavras.map(p => tokens.includes(p) ? 1 : 0)
    }
    
    let pesos = {}
    treinamento.forEach(ex => {
        const vetor = vetorizar(ex.frase)
        if (!pesos[ex.categoria]) pesos[ex.categoria] = new Array(palavras.length).fill(0)
        vetor.forEach((v, i) => { if (v === 1) pesos[ex.categoria][i]++ })
    })
    return { palavras, vetorizar, pesos }
}

function prever(treinamento, frase) {
    if (!treinamento || treinamento.length === 0) return { intencao: "desconhecido", confianca: 0 }
    
    const ia = construirIA(treinamento)
    const entrada = ia.vetorizar(frase)
    let melhor = "desconhecido", scoreMax = -1

    for (let cat in ia.pesos) {
        const score = entrada.reduce((acc, v, i) => acc + (v * ia.pesos[cat][i]), 0)
        if (score > scoreMax) {
            scoreMax = score
            melhor = cat
        }
    }

    const confianca = scoreMax > 0 ? (sigmoid(scoreMax) * 100).toFixed(2) : 0
    return { intencao: melhor, confianca }
}

// ====== PESQUISA WEB (API WIKIPEDIA ESTÁVEL) ======
async function pesquisarWeb(query) {
    return new Promise((resolve) => {
        // Usamos a API em português da Wikipedia. Ela retorna JSON limpo e nunca bloqueia.
        const options = {
            hostname: 'pt.wikipedia.org',
            path: `/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`,
            method: 'GET',
            headers: {
                'User-Agent': 'IA-Engine-Bot/1.0 (Node.js)'
            }
        };

        const req = https.get(options, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    
                    // Verifica se a busca trouxe resultados
                    if (json.query && json.query.search && json.query.search.length > 0) {
                        const titulo = json.query.search[0].title;
                        // O 'snippet' vem com marcações HTML (ex: <span>), então limpamos elas
                        let resumo = json.query.search[0].snippet.replace(/<[^>]+>/g, "");
                        
                        // Retorna de forma amigável
                        resolve(`Segundo a Wikipédia sobre "${titulo}": ${resumo}...`);
                    } else {
                        resolve("Não encontrei informações factuais sobre isso na minha base de dados da enciclopédia.");
                    }
                } catch (e) {
                    resolve("Busca concluída, mas não consegui ler o formato dos dados.");
                }
            });
        });

        req.on("error", () => resolve("Sem conexão de rede no momento."));
        req.setTimeout(5000, () => { req.destroy(); resolve("A pesquisa excedeu o tempo limite."); });
    });
}

// ====== LÓGICA DE RESPOSTA ======
async function obterResposta(modelo, frase, pred) {
    // 1. Se a confiança for alta e houver resposta treinada, usa ela
    if (parseFloat(pred.confianca) > 70 && modelo.respostas && modelo.respostas[pred.intencao]) {
        return modelo.respostas[pred.intencao]["__default"] || "Sem resposta padrão.";
    }

    // 2. Fallback: Pesquisa na Wikipedia
    return await pesquisarWeb(frase)
}

// ====== SERVIDOR ======
const server = http.createServer((req, res) => {
    // Rota Frontend
    if (req.method === "GET" && !req.url.startsWith("/api")) {
        let file = req.url === "/" ? "index.html" : req.url
        const filePath = path.join(PUBLIC_DIR, file)
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404)
                res.end("Crie a pasta 'public' e coloque o seu 'index.html' nela.")
                return
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            res.end(data)
        })
        return
    }

    // API: Treinar
    if (req.method === "POST" && req.url === "/api/train") {
        let body = ""
        req.on("data", chunk => body += chunk)
        req.on("end", () => {
            try {
                const { frase, categoria, resposta } = JSON.parse(body)
                const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} })
                
                modelo.treinamento.push({ frase, categoria })
                if (resposta) {
                    if (!modelo.respostas[categoria]) modelo.respostas[categoria] = {}
                    modelo.respostas[categoria]["__default"] = resposta
                }
                
                salvarJSON(MODEL_PATH, modelo)
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({ status: "Treinado" }))
            } catch (e) {
                res.writeHead(400); res.end("Erro no JSON")
            }
        })
    }

    // API: Testar
    if (req.method === "POST" && req.url === "/api/test") {
        let body = ""
        req.on("data", chunk => body += chunk)
        req.on("end", async () => {
            try {
                const { frase, modo } = JSON.parse(body)
                const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} })
                
                const pred = prever(modelo.treinamento, frase)
                
                if (modo === "resposta") {
                    pred.resposta = await obterResposta(modelo, frase, pred)
                }
                
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify(pred))
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: "Erro no processamento" }))
            }
        })
    }
})

server.listen(PORT, () => {
    console.log(`\n🚀 IA Engine Online!`)
    console.log(`🔗 http://localhost:${PORT}`)
    console.log(`📁 Certifique-se de que o index.html está em: ${PUBLIC_DIR}\n`)
})
