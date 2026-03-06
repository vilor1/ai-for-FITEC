const http = require("http")
const https = require("https")
const fs = require("fs")
const path = require("path")

const PORT = process.env.PORT || 3000

// Configuração de Diretórios
const DATA_DIR = path.join(__dirname, "data")
const PUBLIC_DIR = path.join(__dirname, "public")

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR)

const MODEL_PATH = path.join(DATA_DIR, "model.json")
const MEMORIA_PATH = path.join(DATA_DIR, "memoria.json")

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

// ====== CRAWLER CORRIGIDO ======
function extrairTexto(html) {
    let texto = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()

    // Tenta focar nos resultados reais do DuckDuckGo HTML
    const snippetStart = texto.indexOf("Web Results")
    if (snippetStart !== -1) texto = texto.substring(snippetStart)

    return texto.length > 20 ? texto.slice(0, 500) : "Não encontrei resultados claros na busca."
}

function pesquisarWeb(query) {
    return new Promise(resolve => {
        const options = {
            hostname: 'html.duckduckgo.com',
            path: '/html/?q=' + encodeURIComponent(query),
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
            }
        }

        const req = https.get(options, res => {
            let data = ""
            res.on("data", chunk => data += chunk)
            res.on("end", () => resolve(extrairTexto(data)))
        })

        req.on("error", () => resolve("Erro na conexão de rede."))
        req.setTimeout(5000, () => { req.destroy(); resolve("A busca expirou (timeout).") })
    })
}

// ====== LÓGICA DE RESPOSTA ======
async function responder(modelo, frase, intencao, confianca) {
    // Se a confiança for muito baixa (IA não sabe), vai direto pra web
    if (parseFloat(confianca) < 60) {
        return await pesquisarWeb(frase)
    }

    if (modelo.respostas && modelo.respostas[intencao]) {
        const ops = modelo.respostas[intencao]
        return ops["__default"] || "Não tenho uma resposta padrão para isso."
    }

    return await pesquisarWeb(frase)
}

// ====== SERVIDOR ======
const server = http.createServer((req, res) => {
    // Rota Frontend (Serve o index.html)
    if (req.method === "GET" && !req.url.startsWith("/api")) {
        let file = req.url === "/" ? "index.html" : req.url
        const filePath = path.join(PUBLIC_DIR, file)
        
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404); res.end("Arquivo não encontrado. Verifique se o index.html está na pasta /public");
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
            const { frase, categoria, resposta } = JSON.parse(body)
            const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} })
            
            modelo.treinamento.push({ frase, categoria })
            if (resposta) {
                if (!modelo.respostas[categoria]) modelo.respostas[categoria] = {}
                modelo.respostas[categoria]["__default"] = resposta
            }
            
            salvarJSON(MODEL_PATH, modelo)
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ status: "Treinado com sucesso" }))
        })
    }

    // API: Testar / Perguntar
    if (req.method === "POST" && req.url === "/api/test") {
        let body = ""
        req.on("data", chunk => body += chunk)
        req.on("end", async () => {
            try {
                const { frase, modo } = JSON.parse(body)
                const modelo = carregarJSON(MODEL_PATH, { treinamento: [], respostas: {} })
                
                const pred = prever(modelo.treinamento, frase)
                
                if (modo === "resposta") {
                    pred.resposta = await responder(modelo, frase, pred.intencao, pred.confianca)
                }
                
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify(pred))
            } catch (e) {
                res.writeHead(500); res.end(JSON.stringify({ error: "Erro interno" }))
            }
        })
    }
})

server.listen(PORT, () => {
    console.log(`\x1b[32m%s\x1b[0m`, `IA Engine rodando em http://localhost:${PORT}`)
    console.log(`Certifique-se de que o seu HTML está em: ${PUBLIC_DIR}/index.html`)
})
