const http = require("http")
const https = require("https")
const fs = require("fs")
const path = require("path")

const PORT = process.env.PORT || 3000

const DATA_DIR = path.join(__dirname,"data")
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const MODEL_PATH = path.join(DATA_DIR,"model.json")
const MEMORIA_PATH = path.join(DATA_DIR,"memoria.json")

// ====== UTILIDADES ======
function carregarJSON(file, defaultObj){ 
  if(!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(defaultObj,null,2))
  return JSON.parse(fs.readFileSync(file))
}
function salvarJSON(file,obj){ fs.writeFileSync(file, JSON.stringify(obj,null,2)) }
function tokenizar(texto){ return texto.toLowerCase().replace(/[^\w\s]/g,"").split(/\s+/) }
function sigmoid(x){ return 1/(1+Math.exp(-x)) }

// ====== MODELO IA ======
function construirIA(treinamento){
    const palavras = [...new Set(treinamento.flatMap(t=>tokenizar(t.frase)))]
    const vetorizar = frase => palavras.map(p => tokenizar(frase).includes(p)?1:0)
    let pesos = {}
    treinamento.forEach(ex=>{
        const vetor = vetorizar(ex.frase)
        if(!pesos[ex.categoria]) pesos[ex.categoria] = new Array(palavras.length).fill(0)
        vetor.forEach((v,i)=>{if(v===1) pesos[ex.categoria][i]++})
    })
    return {palavras, vetorizar, pesos}
}

function prever(treinamento,frase){
    if(treinamento.length===0) return {intencao:"desconhecido",confianca:0}
    const ia = construirIA(treinamento)
    const entrada = ia.vetorizar(frase)
    let melhor = "desconhecido", scoreMax = -Infinity
    for(let cat in ia.pesos){
        const score = entrada.reduce((acc,v,i)=>acc+v*ia.pesos[cat][i],0)
        if(score > scoreMax){ scoreMax=score; melhor=cat }
    }
    return {intencao:melhor,confianca:(sigmoid(scoreMax)*100).toFixed(2)}
}

// ====== MEMÓRIA DE CONVERSA ======
function adicionarMemoria(user,frase,resposta){
    const memoria = carregarJSON(MEMORIA_PATH,{})
    if(!memoria[user]) memoria[user] = []
    memoria[user].push({input:frase,output:resposta,timestamp:Date.now()})
    salvarJSON(MEMORIA_PATH,memoria)
}

// ====== RANKING DE RESPOSTAS ======
function atualizarRanking(modelo,categoria,resposta){
    if(!modelo.ranking) modelo.ranking = {}
    if(!modelo.ranking[categoria]) modelo.ranking[categoria]={}
    if(!modelo.ranking[categoria][resposta]) modelo.ranking[categoria][resposta]=1
    else modelo.ranking[categoria][resposta]++
}

// ====== CRAWLER SIMPLES ======
function extrairTexto(html){
    return html.replace(/<script[\s\S]*?<\/script>/gi,"")
               .replace(/<style[\s\S]*?<\/style>/gi,"")
               .replace(/<[^>]+>/g," ")
               .replace(/\s+/g," ")
               .trim()
               .slice(0,500)
}

function pesquisarWeb(query){
    return new Promise(resolve=>{
        const url = "https://duckduckgo.com/html/?q="+encodeURIComponent(query)
        https.get(url,res=>{
            let data=""
            res.on("data",chunk=>data+=chunk)
            res.on("end",()=>resolve(extrairTexto(data)))
        }).on("error",()=>resolve("Não consegui buscar online."))
    })
}

// ====== RESPONDER ======
async function responder(modelo,frase,intencao){
    // prioridade: respostas treinadas
    if(modelo.respostas && modelo.respostas[intencao]){
        const ops = modelo.respostas[intencao]
        // ranking: ordena respostas mais usadas
        const respList = Object.keys(ops)
            .filter(k=>k!=="__default")
            .sort((a,b)=> (modelo.ranking?.[intencao]?.[b]||0) - (modelo.ranking?.[intencao]?.[a]||0))
        if(respList.length>0) return respList[0]
        if(ops.__default) return ops.__default
    }
    // fallback: busca online
    return await pesquisarWeb(frase)
}

// ====== SERVIDOR ======
const server = http.createServer((req,res)=>{
    // Frontend
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
            const {frase,categoria,resposta} = JSON.parse(body)
            const modelo = carregarJSON(MODEL_PATH,{treinamento:[],respostas:{},ranking:{}})
            modelo.treinamento.push({frase,categoria})
            if(resposta){
                if(!modelo.respostas[categoria]) modelo.respostas[categoria]={}
                modelo.respostas[categoria]["__default"]=resposta
            }
            salvarJSON(MODEL_PATH,modelo)
            res.writeHead(200,{"Content-Type":"application/json"})
            res.end(JSON.stringify({status:"Treinado"}))
        })
    }

    // Testar IA
    if(req.method==="POST" && req.url==="/api/test"){
        let body=""
        req.on("data",chunk=>body+=chunk)
        req.on("end",async ()=>{
            const {frase,modo,user="anon"} = JSON.parse(body)
            const modelo = carregarJSON(MODEL_PATH,{treinamento:[],respostas:{},ranking:{}})
            const pred = prever(modelo.treinamento,frase)
            if(modo==="resposta"){
                const resp = await responder(modelo,frase,pred.intencao)
                pred.resposta = resp
                adicionarMemoria(user,frase,resp)
                atualizarRanking(modelo,pred.intencao,resp)
                salvarJSON(MODEL_PATH,modelo)
            }
            res.writeHead(200,{"Content-Type":"application/json"})
            res.end(JSON.stringify(pred))
        })
    }
})

server.listen(PORT,()=>console.log("IA Avançada rodando na porta "+PORT))
