/* BOLTIV BACKEND */

const http=require("node:http");
const PORT=process.env.PORT||3000;
const users=new Map();

function send(res,status,data){
    res.writeHead(status,{"Content-Type":"application/json"});
    res.end(JSON.stringify(data));
}

async function readBody(req){
    return new Promise((resolve,reject)=>{
        let body="";
        req.on("data",chunk=>body+=chunk);
        req.on("end",()=>{
            try{resolve(body?JSON.parse(body):{});}
            catch(error){reject(error);}
        });
        req.on("error",reject);
    });
}

const server=http.createServer(async(req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");

    if(req.method==="OPTIONS"){
        res.writeHead(204);
        return res.end();
    }

    const url=new URL(req.url,"http://localhost");
    const path=url.pathname;

    /* HEALTH */
    if(req.method==="GET"&&path==="/api/health"){
        return send(res,200,{
            success:true,
            app:"BOLTIV",
            status:"online",
            message:"BOLTIV backend is running"
        });
    }

    /* CREATE WALLET */
    if(req.method==="POST"&&path==="/api/wallet/create"){
        try{
            const body=await readBody(req);
            const userId=String(body.userId||"").trim();

            if(!userId){
                return send(res,400,{
                    success:false,
                    message:"User ID is required"
                });
            }

            if(!users.has(userId)){
                users.set(userId,{
                    balance:0,
                    transactions:[]
                });
            }

            const user=users.get(userId);

            return send(res,200,{
                success:true,
                message:"Wallet ready",
                userId,
                balance:user.balance
            });
        }catch(error){
            return send(res,400,{
                success:false,
                message:"Invalid request"
            });
        }
    }

    /* GET WALLET */
    if(req.method==="GET"&&path==="/api/wallet"){
        const userId=url.searchParams.get("userId");

        if(!userId){
            return send(res,400,{
                success:false,
                message:"User ID is required"
            });
        }

        const user=users.get(userId);

        if(!user){
            return send(res,404,{
                success:false,
                message:"Wallet not found"
            });
        }

        return send(res,200,{
            success:true,
            userId,
            balance:user.balance,
            transactions:user.transactions
        });
    }

    /* 404 */
    return send(res,404,{
        success:false,
        message:"API route not found"
    });
});

server.listen(PORT,()=>{
    console.log(`BOLTIV API running on port ${PORT}`);
});

/* END OF BOLTIV BACKEND */
