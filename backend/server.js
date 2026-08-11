/* BOLTIV BACKEND — POSTGRESQL + PAYSTACK WALLET */

const http=require("node:http");
const crypto=require("node:crypto");
const {Pool}=require("pg");

const PORT=process.env.PORT||3000;
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://thatsdeeko.github.io/boltiv";
const DATABASE_URL=process.env.DATABASE_URL||"";

const pool=new Pool({
    connectionString:DATABASE_URL,
    ssl:DATABASE_URL?{rejectUnauthorized:false}:false
});

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

async function db(query,params=[]){
    const result=await pool.query(query,params);
    return result;
}

async function initializeDatabase(){
    if(!DATABASE_URL){
        console.log("DATABASE_URL is not configured.");
        return;
    }

    await db(`
        CREATE TABLE IF NOT EXISTS wallets(
            user_id TEXT PRIMARY KEY,
            balance NUMERIC(14,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await db(`
        CREATE TABLE IF NOT EXISTS transactions(
            id BIGSERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL,
            service TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            reference TEXT UNIQUE,
            status TEXT NOT NULL,
            date TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await db(`
        CREATE TABLE IF NOT EXISTS payments(
            reference TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            email TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            amount_kobo BIGINT NOT NULL,
            status TEXT NOT NULL,
            credited BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            credited_at TIMESTAMPTZ
        )
    `);

    console.log("PostgreSQL database ready.");
}

async function createWallet(userId){
    await db(`
        INSERT INTO wallets(user_id,balance)
        VALUES($1,0)
        ON CONFLICT(user_id) DO NOTHING
    `,[userId]);
}

async function getWallet(userId){
    const result=await db(`
        SELECT user_id,balance
        FROM wallets
        WHERE user_id=$1
    `,[userId]);

    if(!result.rows.length)return null;

    return{
        userId:result.rows[0].user_id,
        balance:Number(result.rows[0].balance)
    };
}

async function getTransactions(userId){
    const result=await db(`
        SELECT
            type,
            service,
            amount,
            reference,
            status,
            date
        FROM transactions
        WHERE user_id=$1
        ORDER BY date DESC
    `,[userId]);

    return result.rows.map(transaction=>({
        ...transaction,
        amount:Number(transaction.amount)
    }));
}

async function createReference(){
    return`BOLTIV-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
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

    return{
        httpStatus:response.status,
        data
    };
}

async function initializePayment({userId,email,amount}){
    if(!PAYSTACK_SECRET_KEY){
        return{
            success:false,
            message:"Paystack is not configured on the server."
        };
    }

    const reference=await createReference();

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

    await db(`
        INSERT INTO payments(
            reference,
            user_id,
            email,
            amount,
            amount_kobo,
            status,
            credited
        )
        VALUES($1,$2,$3,$4,$5,$6,$7)
    `,[
        reference,
        userId,
        email,
        amount,
        Math.round(amount*100),
        "initialized",
        false
    ]);

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

    const paymentResult=await db(`
        SELECT
            reference,
            user_id,
            email,
            amount,
            amount_kobo,
            status,
            credited
        FROM payments
        WHERE reference=$1
    `,[reference]);

    if(!paymentResult.rows.length){
        return{
            success:false,
            message:"Payment reference not found."
        };
    }

    const payment=paymentResult.rows[0];

    if(payment.credited){
        const wallet=await getWallet(payment.user_id);

        return{
            success:true,
            alreadyCredited:true,
            message:"Payment was already credited.",
            reference,
            balance:wallet?wallet.balance:0
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
        await db(`
            UPDATE payments
            SET status=$1
            WHERE reference=$2
        `,[
            transaction.status,
            reference
        ]);

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

    if(Number(transaction.amount)!==Number(payment.amount_kobo)){
        return{
            success:false,
            message:"Payment amount does not match wallet funding amount."
        };
    }

    const client=await pool.connect();

    try{
        await client.query("BEGIN");

        await client.query(`
            INSERT INTO wallets(user_id,balance)
            VALUES($1,0)
            ON CONFLICT(user_id) DO NOTHING
        `,[payment.user_id]);

        const walletResult=await client.query(`
            UPDATE wallets
            SET
                balance=balance+$1,
                updated_at=NOW()
            WHERE user_id=$2
            RETURNING balance
        `,[
            Number(payment.amount),
            payment.user_id
        ]);

        await client.query(`
            INSERT INTO transactions(
                user_id,
                type,
                service,
                amount,
                reference,
                status
            )
            VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(reference) DO NOTHING
        `,[
            payment.user_id,
            "credit",
            "Wallet Funding",
            Number(payment.amount),
            reference,
            "successful"
        ]);

        await client.query(`
            UPDATE payments
            SET
                status='success',
                credited=TRUE,
                credited_at=NOW()
            WHERE reference=$1
        `,[reference]);

        await client.query("COMMIT");

        return{
            success:true,
            message:"Wallet funded successfully.",
            reference,
            amount:Number(payment.amount),
            balance:Number(walletResult.rows[0].balance)
        };

    }catch(error){
        await client.query("ROLLBACK");
        throw error;
    }finally{
        client.release();
    }
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
            database:DATABASE_URL?"configured":"not configured",
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

            await createWallet(userId);

            const wallet=await getWallet(userId);

            return send(res,200,{
                success:true,
                message:"Wallet ready",
                userId,
                balance:wallet.balance
            });

        }catch(error){
            console.error("CREATE WALLET ERROR:",error);

            return send(res,500,{
                success:false,
                message:"Unable to create wallet."
            });
        }
    }

    /* GET WALLET */
    if(req.method==="GET"&&path==="/api/wallet"){
        try{
            const userId=url.searchParams.get("userId");

            if(!userId){
                return send(res,400,{
                    success:false,
                    message:"User ID is required"
                });
            }

            const wallet=await getWallet(userId);

            if(!wallet){
                return send(res,404,{
                    success:false,
                    message:"Wallet not found"
                });
            }

            const transactions=await getTransactions(userId);

            return send(res,200,{
                success:true,
                userId,
                balance:wallet.balance,
                transactions
            });

        }catch(error){
            console.error("GET WALLET ERROR:",error);

            return send(res,500,{
                success:false,
                message:"Unable to load wallet."
            });
        }
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

            await createWallet(userId);

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

initializeDatabase()
.then(()=>{
    server.listen(PORT,()=>{
        console.log(`BOLTIV API running on port ${PORT}`);
    });
})
.catch(error=>{
    console.error("DATABASE STARTUP ERROR:",error);
    process.exit(1);
});

/* END OF BOLTIV BACKEND */
