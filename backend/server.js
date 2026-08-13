const http=require("node:http");
const crypto=require("node:crypto");
const {Pool}=require("pg");

const PORT=process.env.PORT||3000;
const DATABASE_URL=process.env.DATABASE_URL||"";
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://thatsdeeko.github.io/boltiv";

const ADMIN_EMAIL=process.env.ADMIN_EMAIL||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

const VTU_API_URL=process.env.VTU_API_URL||"";
const VTU_API_KEY=process.env.VTU_API_KEY||"";

const pool=new Pool({
connectionString:DATABASE_URL,
ssl:DATABASE_URL
?{rejectUnauthorized:false}
:false
});

function send(res,status,data){
res.writeHead(status,{
"Content-Type":"application/json",
"Access-Control-Allow-Origin":"*",
"Access-Control-Allow-Methods":"GET,POST,OPTIONS",
"Access-Control-Allow-Headers":
"Content-Type,Authorization"
});
res.end(JSON.stringify(data));
}

async function body(req){
return new Promise((resolve,reject)=>{
let data="";

req.on("data",chunk=>{
data+=chunk;
});

req.on("end",()=>{
try{
resolve(data?JSON.parse(data):{});
}catch(error){
reject(error);
}
});

req.on("error",reject);
});
}

async function db(query,params=[]){
return pool.query(query,params);
}

function clean(value){
return String(value??"").trim();
}

function validPhone(phone){
return /^0\d{10}$/.test(phone);
}

function validAmount(amount){
return Number.isFinite(amount)&&amount>0;
}

function validEmail(email){
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function token(){
return crypto.randomBytes(32).toString("hex");
}

function reference(prefix="BOLTIV"){
return `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
}

function hashPassword(
password,
salt=crypto.randomBytes(16).toString("hex")
){
const hash=crypto.scryptSync(
password,
salt,
64
).toString("hex");

return `${salt}:${hash}`;
}

function verifyPassword(password,stored){
try{
const parts=String(stored||"").split(":");

if(parts.length!==2){
return false;
}

const salt=parts[0];
const key=Buffer.from(parts[1],"hex");

const hash=crypto.scryptSync(
password,
salt,
64
);

if(hash.length!==key.length){
return false;
}

return crypto.timingSafeEqual(
hash,
key
);

}catch(error){

console.error(
"PASSWORD VERIFY ERROR:",
error.message
);

return false;
}
}
async function setup(){
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

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS provider_reference TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS phone TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS network TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS plan TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS meter_number TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS meter_type TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS smartcard_number TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS cable_package TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS provider TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS response_data JSONB
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
`);

await db(`
UPDATE transactions
SET created_at=date
WHERE created_at IS NULL
`);

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
admin_id BIGINT NOT NULL
REFERENCES admins(id)
ON DELETE CASCADE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)`);

await syncAdmin();

console.log("PostgreSQL database ready.");
}

async function syncAdmin(){
if(!ADMIN_EMAIL||!ADMIN_PASSWORD){
console.log(
"ADMIN_EMAIL or ADMIN_PASSWORD is missing."
);
return;
}

const result=await db(
`SELECT id,email,password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!result.rows.length){

await db(
`INSERT INTO admins(
email,password_hash
)
VALUES($1,$2)`,
[
ADMIN_EMAIL,
hashPassword(ADMIN_PASSWORD)
]
);

console.log("Admin account created.");

}else{

await db(
`UPDATE admins
SET email=$1,
password_hash=$2
WHERE id=$3`,
[
ADMIN_EMAIL,
hashPassword(ADMIN_PASSWORD),
result.rows[0].id
]
);

console.log("Admin account synchronized.");
}
}

async function createWallet(userId){
await db(
`INSERT INTO wallets(
user_id,balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[userId]
);
}

async function wallet(userId){
const result=await db(
`SELECT user_id,balance
FROM wallets
WHERE user_id=$1`,
[userId]
);

if(!result.rows.length){
return null;
}

return{
userId:result.rows[0].user_id,
balance:Number(result.rows[0].balance)
};
}

async function transactions(userId){
const result=await db(
`SELECT
id,type,service,amount,reference,
provider_reference,status,
phone,network,plan,
meter_number,meter_type,
smartcard_number,
cable_package,provider,
response_data,date,created_at
FROM transactions
WHERE user_id=$1
ORDER BY date DESC`,
[userId]
);

return result.rows.map(row=>({
...row,
amount:Number(row.amount)
}));
}
