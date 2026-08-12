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
