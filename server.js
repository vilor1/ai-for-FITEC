const http = require("http")
const fs = require("fs")
const path = require("path")

const PORT = process.env.PORT || 3000

// Pasta persistente no Railway
const DATA_DIR = path.join(__dirname,"data")
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const MODEL_PATH = path.join(DATA_DIR,"model.json")

const sigmoid = x => 1 / (1 + Math.exp(-x))

function carregarModelo(){
    if(!fs.existsSync(MODEL_PATH)){
        fs.writeFileSync(MODEL_PATH,JSON.stringify({treinamento:[]},null,2))
    }
    return JSON.parse(fs.readFileSync(MODEL_PATH))
}

function salvarModelo(modelo){
    fs.writeFileSync(MODEL_PATH,JSON.stringify(modelo,null,2))
}

function tokenizar(texto){
    return texto
        .toLowerCase()
        .replace(/[^\w\s]/g,"")
        .split(/\s+/)
}

function construirIA(treinamento){
    const palavrasChave = [...new Set(treinamento.flatMap(t=>tokenizar(t.frase)))]
    const vetorizar = frase => palavrasChave.map(p => tokenizar(frase).includes(p)?1:0)
    let pesos = {}
    treinamento.forEach(exemplo=>{
        const vetor = vetorizar(exemplo.frase)
        if(!pesos[exemplo.categoria]) pesos[exemplo.categoria] = new Array(palavrasChave.length).fill(0)
        vetor.forEach((bit,i)=>{if(bit===1) pesos[exemplo.categoria][i]++})
    })
    return {pesos,palavrasChave,vetorizar}
}

function prever(treinamento,frase){
    if(treinamento.length===0) return {intencao:"Sem treino",confianca:"0%"}
    const ia = construirIA(treinamento)
    const vetorEntrada = ia.vetorizar(frase)
    let melhorCategoria="Desconhecido"
    let maiorPontuacao=-Infinity
    Object.keys(ia.pesos).forEach(cat=>{
        const score = vetorEntrada.reduce((acc,bit,i)=>acc+(bit*ia.pesos[cat][i]),0)
        const prob = sigmoid(score)
        if(prob>maiorPontuacao){
            maiorPontuacao=prob
            melhorCategoria=cat
        }
    })
    return {intencao:melhorCategoria,confianca:(maiorPontuacao*100).toFixed(2)+"%"}
}

const server = http.createServer((req,res)=>{
    // Servir frontend
    if(req.method==="GET"){
        let file = req.url==="/"?"/index.html":req.url
        const filePath = path.join(__dirname,"public",file)
        fs.readFile(filePath,(err,data)=>{
            if(err){res.writeHead(404);res.end("Not found");return}
            res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"})
            res.end(data)
        })
    }

    // Treinar IA
    if(req.method==="POST" && req.url==="/api/train"){
        let body=""
        req.on("data",chunk=>body+=chunk)
        req.on("end",()=>{
            const {frase,categoria}=JSON.parse(body)
            const modelo = carregarModelo()
            modelo.treinamento.push({frase,categoria})
            salvarModelo(modelo)
            res.writeHead(200,{"Content-Type":"application/json"})
            res.end(JSON.stringify({status:"Treinado"}))
        })
    }

    // Testar IA
    if(req.method==="POST" && req.url==="/api/test"){
        let body=""
        req.on("data",chunk=>body+=chunk)
        req.on("end",()=>{
            const {frase}=JSON.parse(body)
            const modelo = carregarModelo()
            const resultado = prever(modelo.treinamento,frase)
            res.writeHead(200,{"Content-Type":"application/json"})
            res.end(JSON.stringify(resultado))
        })
    }
})

server.listen(PORT,()=>console.log("IA rodando na porta",PORT))
