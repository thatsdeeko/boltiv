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

async function body(req){
return new Promise((resolve,reject)=>{
let data="";
req.on("data",c=>data+=c);
req.on("end",()=>{
try{
resolve(data?JSON.parse(data):{});
}catch(e){
reject(e);
}
});
req.on("error",reject);
});
}

async function db(q,p=[]){
return pool.query(q,p);
}

function clean(v){
return String(v??"").trim();
}

function validEmail(v){
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function validPhone(v){
return /^0\d{10}$/.test(v);
}

function validAmount(v){
return Number.isFinite(v)&&v>0;
}

function token(){
return crypto.randomBytes(32).toString("hex");
}

function reference(prefix="BOLTIV"){
return `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
}

function hashPassword(password,salt=crypto.randomBytes(16).toString("hex")){
const hash=crypto.scryptSync(password,salt,64).toString("hex");
return `${salt}:${hash}`;
}

function verifyPassword(password,stored){
try{
const parts=String(stored||"").split(":");
if(parts.length!==2)return false;
const salt=parts[0];
const key=Buffer.from(parts[1],"hex");
const hash=crypto.scryptSync(password,salt,64);
if(hash.length!==key.length)return false;
return crypto.timingSafeEqual(hash,key);
}catch(e){
console.error("PASSWORD VERIFY ERROR:",e.message);
return false;
}
}

function authToken(req){
const h=req.headers.authorization||"";
if(!h.startsWith("Bearer "))return "";
return h.slice(7).trim();
}

async function setup(){
if(!DATABASE_URL){
console.log("DATABASE_URL is not configured.");
return;
}

await db(`CREATE TABLE IF NOT EXISTS users(
id BIGSERIAL PRIMARY KEY,
full_name TEXT NOT NULL,
phone TEXT NOT NULL,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`CREATE TABLE IF NOT EXISTS user_sessions(
token TEXT PRIMARY KEY,
user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)`);

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

await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_reference TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS phone TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS network TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS plan TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS meter_number TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS meter_type TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS smartcard_number TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cable_package TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS response_data JSONB`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`);
await db(`UPDATE transactions SET created_at=date WHERE created_at IS NULL`);

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

await syncAdmin();
console.log("PostgreSQL database ready.");
  }
async function syncAdmin(){
if(!ADMIN_EMAIL||!ADMIN_PASSWORD){
console.log("ADMIN_EMAIL or ADMIN_PASSWORD is missing.");
return;
}

const r=await db(
`SELECT id,email,password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!r.rows.length){
await db(
`INSERT INTO admins(email,password_hash)
VALUES($1,$2)`,
[ADMIN_EMAIL,hashPassword(ADMIN_PASSWORD)]
);
console.log("Admin account created.");
}else{
await db(
`UPDATE admins
SET email=$1,password_hash=$2
WHERE id=$3`,
[
ADMIN_EMAIL,
hashPassword(ADMIN_PASSWORD),
r.rows[0].id
]
);
console.log("Admin account synchronized.");
}
}

async function createWallet(userId){
await db(
`INSERT INTO wallets(user_id,balance)
VALUES($1,0)
ON CONFLICT(user_id) DO NOTHING`,
[userId]
);
}

async function wallet(userId){
const r=await db(
`SELECT user_id,balance
FROM wallets
WHERE user_id=$1`,
[userId]
);

if(!r.rows.length)return null;

return{
userId:r.rows[0].user_id,
balance:Number(r.rows[0].balance)
};
}

async function transactions(userId){
const r=await db(
`SELECT id,type,service,amount,reference,
provider_reference,status,phone,network,plan,
meter_number,meter_type,smartcard_number,
cable_package,provider,response_data,date,created_at
FROM transactions
WHERE user_id=$1
ORDER BY date DESC
LIMIT 200`,
[userId]
);

return r.rows.map(x=>({
...x,
amount:Number(x.amount)
}));
}

async function customerFromToken(t){
if(!t)return null;

const r=await db(
`SELECT u.id,u.full_name,u.phone,u.email,u.created_at
FROM user_sessions s
JOIN users u ON u.id=s.user_id
WHERE s.token=$1
AND s.expires_at>NOW()`,
[t]
);

return r.rows[0]||null;
}

async function customer(req){
return customerFromToken(authToken(req));
}

async function registerCustomer(data){
const name=clean(data.name||data.fullName);
const phone=clean(data.phone||data.phoneNumber);
const email=clean(data.email).toLowerCase();
const password=String(data.password||"");

if(name.length<2){
return{success:false,statusCode:400,message:"Full name is required."};
}

if(!validPhone(phone)){
return{success:false,statusCode:400,message:"Enter a valid Nigerian phone number."};
}

if(!validEmail(email)){
return{success:false,statusCode:400,message:"Enter a valid email address."};
}

if(password.length<6){
return{success:false,statusCode:400,message:"Password must contain at least 6 characters."};
}

const existing=await db(
`SELECT id FROM users
WHERE LOWER(email)=LOWER($1)
OR phone=$2`,
[email,phone]
);

if(existing.rows.length){
return{
success:false,
statusCode:409,
message:"An account with this email or phone already exists."
};
}

const r=await db(
`INSERT INTO users(
full_name,phone,email,password_hash
)
VALUES($1,$2,$3,$4)
RETURNING id,full_name,phone,email,created_at`,
[
name,
phone,
email,
hashPassword(password)
]
);

const u=r.rows[0];
await createWallet(String(u.id));

const session=token();

await db(
`INSERT INTO user_sessions(
token,user_id,expires_at
)
VALUES($1,$2,NOW()+INTERVAL '30 days')`,
[
session,
u.id
]
);

return{
success:true,
statusCode:201,
message:"Account created successfully.",
token:session,
user:{
id:u.id,
name:u.full_name,
fullName:u.full_name,
phone:u.phone,
email:u.email,
createdAt:u.created_at
},
balance:0
};
}

async function loginCustomer(email,password){
email=clean(email).toLowerCase();
password=String(password||"");

if(!validEmail(email)||!password){
return{
success:false,
statusCode:400,
message:"Email and password are required."
};
}

const r=await db(
`SELECT id,full_name,phone,email,password_hash,created_at
FROM users
WHERE LOWER(email)=LOWER($1)`,
[email]
);

if(!r.rows.length){
return{
success:false,
statusCode:401,
message:"Invalid email or password."
};
}

const u=r.rows[0];

if(!verifyPassword(password,u.password_hash)){
return{
success:false,
statusCode:401,
message:"Invalid email or password."
};
}

await db(
`DELETE FROM user_sessions
WHERE expires_at<NOW()`
);

const t=token();

await db(
`INSERT INTO user_sessions(
token,user_id,expires_at
)
VALUES($1,$2,NOW()+INTERVAL '30 days')`,
[t,u.id]
);

await createWallet(String(u.id));

const w=await wallet(String(u.id));

return{
success:true,
statusCode:200,
message:"Login successful.",
token:t,
user:{
id:u.id,
name:u.full_name,
fullName:u.full_name,
phone:u.phone,
email:u.email,
createdAt:u.created_at
},
balance:w?w.balance:0
};
}
