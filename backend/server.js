/* BOLTIV BACKEND — PAYSTACK WALLET */

const http=require("node:http");
const crypto=require("node:crypto");

const PORT=process.env.PORT||3000;
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://thatsdeeko.github.io/boltiv";

const users=new Map();
const payments=new Map();

function send(res,status,data){
    res.writeHead(status,{
        "Content-Type":"application/json",
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type,Authorization"
    });
    res.end(JSON.stringify(data));
}

async function readBody(req){
    return new Promise((resolve,reject)=>{
        let body="";
        req.on("data",chunk=>body+=chunk);
        req.on("end",()=>{
            try{
                resolve(body?JSON.parse(body):{});
            }catch(error){
                reject(error);
            }
        });
        req.on("error",reject);
    });
}

async function paystackRequest(endpoint,options={}){
    const response=await fetch(`https://api.paystack.co${endpoint}`,{
        ...options,
        headers:{
            "Authorization":`Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type":"application/json",
            ...(options.headers||{})
        }
    });

    const data=await response.json();
    return{httpStatus:response.status,data};
}

function getOrCreateWallet(userId){
    if(!users.has(userId)){
        users.set(userId,{
            balance:0,
            transactions:[]
        });
    }

    return users.get(userId);
}

function createReference(){
    return`BOLTIV-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
}

async function initializePayment({userId,email,amount}){
    if(!PAYSTACK_SECRET_KEY){
        return{
            success:false,
            message:"Paystack is not configured on the server."
        };
    }

    const reference=createReference();

    const result=await paystackRequest("/transaction/initialize",{
        method:"POST",
        body:JSON.stringify({
            email,
            amount:String(Math.round(amount*100)),
            currency:"NGN",
            reference,
            callback_url:`${FRONTEND_URL}/payment-success.html`,
            metadata:{
                userId,
                service:"BOLTIV Wallet Funding"
            }
        })
    });

    if(!result.data.status){
        return{
            success:false,
            message:result.data.message||"Unable to initialize Paystack payment."
        };
    }

    payments.set(reference,{
        reference,
        userId,
        email,
        amount,
        amountKobo:Math.round(amount*100),
        status:"initialized",
        credited:false,
        createdAt:new Date().toISOString()
    });

    return{
        success:true,
        message:"Payment initialized",
        reference,
        authorizationUrl:result.data.data.authorization_url,
        accessCode:result.data.data.access_code
    };
}

async function verifyPayment(reference){
    if(!PAYSTACK_SECRET_KEY){
        return{
            success:false,
            message:"Paystack is not configured on the server."
        };
    }

    const payment=payments.get(reference);

    if(!payment){
        return{
            success:false,
            message:"Payment reference not found."
        };
    }

    if(payment.credited){
        return{
            success:true,
            alreadyCredited:true,
            message:"Payment was already credited.",
            reference,
            balance:getOrCreateWallet(payment.userId).balance
        };
    }

    const result=await paystackRequest(
        `/transaction/verify/${encodeURIComponent(reference)}`,
        {method:"GET"}
    );

    if(!result.data.status){
        return{
            success:false,
            message:result.data.message||"Unable to verify payment."
        };
    }

    const transaction=result.data.data;

    if(transaction.status!=="success"){
        payment.status=transaction.status;

        return{
            success:false,
            message:`Payment status: ${transaction.status}`,
            status:transaction.status
        };
    }

    if(transaction.currency!=="NGN"){
        return{
            success:false,
            message:"Invalid payment currency."
        };
    }

    if(Number(transaction.amount)!==Number(payment.amountKobo)){
        return{
            success:false,
            message:"Payment amount does not match wallet funding amount."
        };
    }

    const wallet=getOrCreateWallet(payment.userId);

    wallet.balance+=payment.amount;

    wallet.transactions.unshift({
        type:"credit",
        service:"Wallet Funding",
        amount:payment.amount,
        reference,
        status:"successful",
        date:new Date().toISOString()
    });

    payment.status="success";
    payment.credited=true;
    payment.creditedAt=new Date().toISOString();

    return{
        success:true,
        message:"Wallet funded successfully.",
        reference,
        amount:payment.amount,
        balance:wallet.balance
    };
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
            paystack:PAYSTACK_SECRET_KEY?"configured":"not configured",
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

            const wallet=getOrCreateWallet(userId);

            return send(res,200,{
                success:true,
                message:"Wallet ready",
                userId,
                balance:wallet.balance
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

    /* INITIALIZE PAYSTACK PAYMENT */
    if(req.method==="POST"&&path==="/api/wallet/fund"){
        try{
            const body=await readBody(req);

            const userId=String(body.userId||"").trim();
            const email=String(body.email||"").trim();
            const amount=Number(body.amount);

            if(!userId){
                return send(res,400,{
                    success:false,
                    message:"User ID is required"
                });
            }

            if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
                return send(res,400,{
                    success:false,
                    message:"A valid email is required"
                });
            }

            if(!Number.isFinite(amount)||amount<100){
                return send(res,400,{
                    success:false,
                    message:"Minimum wallet funding amount is ₦100."
                });
            }

            getOrCreateWallet(userId);

            const result=await initializePayment({
                userId,
                email,
                amount
            });

            return send(res,result.success?200:400,result);
        }catch(error){
            console.error("PAYSTACK INITIALIZE ERROR:",error);

            return send(res,500,{
                success:false,
                message:"Unable to initialize payment."
            });
        }
    }

    /* VERIFY PAYSTACK PAYMENT */
    if(req.method==="GET"&&path==="/api/wallet/verify"){
        try{
            const reference=url.searchParams.get("reference");

            if(!reference){
                return send(res,400,{
                    success:false,
                    message:"Payment reference is required."
                });
            }

            const result=await verifyPayment(reference);

            return send(res,result.success?200:400,result);
        }catch(error){
            console.error("PAYSTACK VERIFY ERROR:",error);

            return send(res,500,{
                success:false,
                message:"Unable to verify payment."
            });
        }
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
