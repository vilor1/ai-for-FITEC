const http = require("http")
const https = require("https")
const fs = require("fs")
const path = require("path")

const PORT = process.env.PORT || 3000

const DATA_DIR = path.join(__dirname,"data")
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const MODEL_PATH = path.join(DATA_DIR,"model.json")

function carregarModelo(){
    if(!fs.existsSync(MODEL_PATH)){
        fs.writeFileSync(MODEL_PATH,JSON.stringify({treinamento:[],respostas:{}},null,2))
    }
    return JSON.parse(fs.readFileSync(MODEL_PATH))
}

function salvarModelo(modelo){
    fs.writeFileSync(MODEL_PATH,JSON.stringify(modelo,null,2))
}

function tokenizar(texto){
    return texto.toLowerCase().replace(/[^\w\s]/g,"").split(/\s+/)
}

function construirIA(treinamento){
    const palavras = [...new Set(treinamento.flatMap(t=>tokenizar(t.frase)))]

    const vetorizar = frase =>
        palavras.map(p => tokenizar(frase).includes(p)?1:0)

    let pesos = {}

    treinamento.forEach(ex=>{
        const vetor = vetorizar(ex.frase)

        if(!pesos[ex.categoria])
            pesos[ex.categoria] = new Array(palavras.length).fill(0)

        vetor.forEach((v,i)=>{
            if(v===1) pesos[ex.categoria][i]++
        })
    })

    return {pesos,palavras,vetorizar}
}

function prever(treinamento,frase){

    if(treinamento.length===0)
        return {intencao:"desconhecido",confianca:"0%"}

    const ia = construirIA(treinamento)
    const entrada = ia.vetorizar(frase)

    let melhor = "desconhecido"
    let scoreMax = -Infinity

    for(let cat in ia.pesos){

        const score = entrada.reduce((acc,v,i)=>
            acc + v*ia.pesos[cat][i],0)

        if(score > scoreMax){
            scoreMax = score
            melhor = cat
        }
    }

    return {
        intencao: melhor,
        confianca: scoreMax
    }
}

function extrairTexto(html){

    return html
        .replace(/<script[\s\S]*?<\/script>/gi,"")
        .replace(/<style[\s\S]*?<\/style>/gi,"")
        .replace(/<[^>]+>/g," ")
        .replace(/\s+/g," ")
        .trim()
        .slice(0,500)
}

function pesquisar(query){

    return new Promise(resolve=>{

        const url =
        "https://duckduckgo.com/html/?q="+encodeURIComponent(query)

        https.get(url,res=>{

            let data=""

            res.on("data",chunk=>data+=chunk)

            res.on("end",()=>{

                const texto = extrairTexto(data)

                resolve(texto || "Não encontrei informações.")

            })

        }).on("error",()=>{

            resolve("Erro ao pesquisar.")

        })

    })

}

async function responder(modelo,intencao,frase){

    if(modelo.respostas[intencao]){

        if(modelo.respostas[intencao].default)
            return modelo.respostas[intencao].default
    }

    const info = await pesquisar(frase)

    return info
}

const server = http.createServer((req,res)=>{

    if(req.method==="GET"){

        let file = req.url==="/"?"/index.html":req.url

        const filePath =
        path.join(__dirname,"public",file)

        fs.readFile(filePath,(err,data)=>{

            if(err){
                res.writeHead(404)
                res.end("Not found")
                return
            }

            res.writeHead(200,{"Content-Type":"text/html"})
            res.end(data)

        })
    }

    if(req.method==="POST" && req.url==="/api/train"){

        let body=""

        req.on("data",c=>body+=c)

        req.on("end",()=>{

            const {frase,categoria,resposta} =
            JSON.parse(body)

            const modelo = carregarModelo()

            modelo.treinamento.push({frase,categoria})

            if(resposta){

                if(!modelo.respostas[categoria])
                    modelo.respostas[categoria] = {}

                modelo.respostas[categoria].default = resposta
            }

            salvarModelo(modelo)

            res.writeHead(200,{
                "Content-Type":"application/json"
            })

            res.end(JSON.stringify({status:"ok"}))

        })
    }

    if(req.method==="POST" && req.url==="/api/test"){

        let body=""

        req.on("data",c=>body+=c)

        req.on("end",async ()=>{

            const {frase,modo} = JSON.parse(body)

            const modelo = carregarModelo()

            const result =
            prever(modelo.treinamento,frase)

            if(modo==="resposta"){

                result.resposta =
                await responder(
                    modelo,
                    result.intencao,
                    frase
                )
            }

            res.writeHead(200,{
                "Content-Type":"application/json"
            })

            res.end(JSON.stringify(result))

        })
    }

})

server.listen(PORT,()=>{
    console.log("IA rodando na porta "+PORT)
})
