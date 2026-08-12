const http=require("node:http");
const crypto=require("node:crypto");
const{Pool}=require("pg");

const PORT=process.env.PORT||3000;
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://thatsdeeko.github.io/boltiv";
const DATABASE_URL=process.env.DATABASE_URL||"";
const ADMIN_EMAIL=process.env.ADMIN_EMAIL||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

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
try{resolve(body?JSON.parse(body):{})}
catch(e){reject(e)}
});
req.on("error",reject);
});
}

async function db(query,params=[]){
return await pool.query(query,params);
}

function hashPassword(password,salt=crypto.randomBytes(16).toString("hex")){
return`${salt}:${crypto.scryptSync(password,salt,64).toString("hex")}`;
}

function verifyPassword(password,stored){
try{
const[salt,key]=stored.split(":");
const hash=crypto.scryptSync(password,salt,64).toString("hex");
return crypto.timingSafeEqual(
Buffer.from(hash,"hex"),
Buffer.from(key,"hex")
);
}catch{
return false;
}
}

function createToken(){
return crypto.randomBytes(32).toString("hex");
}

function createReference(){
return`BOLTIV-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
}

// DATABASE
async function initializeDatabase(){
if(!DATABASE_URL){
console.log("DATABASE_URL is not configured.");
return;
}

await db(`CREATE TABLE IF NOT EXISTS wallets(
user_id TEXT PRIMARY KEY,
balance NUMERIC(14,2) NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`CREATE TABLE IF NOT EXISTS transactions(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
type TEXT NOT NULL,
service TEXT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
reference TEXT UNIQUE,
status TEXT NOT NULL,
date TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`CREATE TABLE IF NOT EXISTS payments(
reference TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
email TEXT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
amount_kobo BIGINT NOT NULL,
status TEXT NOT NULL,
credited BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
credited_at TIMESTAMPTZ
)`);

await db(`CREATE TABLE IF NOT EXISTS admins(
id BIGSERIAL PRIMARY KEY,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`CREATE TABLE IF NOT EXISTS admin_sessions(
token TEXT PRIMARY KEY,
admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)`);

if(ADMIN_EMAIL&&ADMIN_PASSWORD){
const existing=await db(
`SELECT id FROM admins WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!existing.rows.length){
await db(
`INSERT INTO admins(email,password_hash) VALUES($1,$2)`,
[ADMIN_EMAIL,hashPassword(ADMIN_PASSWORD)]
);
console.log("Admin account created.");
}
}

console.log("PostgreSQL database ready.");
}

// END OF CHUNK 1
async function createWallet(userId){
await db(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);
}

async function getWallet(userId){
const result=await db(`SELECT user_id,balance FROM wallets WHERE user_id=$1`,[userId]);
if(!result.rows.length)return null;
return{
userId:result.rows[0].user_id,
balance:Number(result.rows[0].balance)
};
}

async function getTransactions(userId){
const result=await db(`SELECT type,service,amount,reference,status,date FROM transactions WHERE user_id=$1 ORDER BY date DESC`,[userId]);
return result.rows.map(x=>({...x,amount:Number(x.amount)}));
}

// PAYSTACK
async function paystackRequest(endpoint,options={}){
const response=await fetch(`https://api.paystack.co${endpoint}`,{
...options,
headers:{
Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,
"Content-Type":"application/json",
...(options.headers||{})
}
});
return{
httpStatus:response.status,
data:await response.json()
};
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

await db(
`INSERT INTO payments(
reference,user_id,email,amount,amount_kobo,status,credited
) VALUES($1,$2,$3,$4,$5,$6,$7)`,
[
reference,
userId,
email,
amount,
Math.round(amount*100),
"initialized",
false
]
);

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

const paymentResult=await db(
`SELECT reference,user_id,email,amount,amount_kobo,status,credited
FROM payments WHERE reference=$1`,
[reference]
);

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
await db(
`UPDATE payments SET status=$1 WHERE reference=$2`,
[transaction.status,reference]
);

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

await client.query(
`INSERT INTO wallets(user_id,balance)
VALUES($1,0)
ON CONFLICT(user_id) DO NOTHING`,
[payment.user_id]
);

const walletResult=await client.query(
`UPDATE wallets
SET balance=balance+$1,updated_at=NOW()
WHERE user_id=$2
RETURNING balance`,
[
Number(payment.amount),
payment.user_id
]
);

await client.query(
`INSERT INTO transactions(
user_id,type,service,amount,reference,status
)
VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT(reference) DO NOTHING`,
[
payment.user_id,
"credit",
"Wallet Funding",
Number(payment.amount),
reference,
"successful"
]
);

await client.query(
`UPDATE payments
SET status='success',
credited=TRUE,
credited_at=NOW()
WHERE reference=$1`,
[reference]
);

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

// END OF CHUNK 2
