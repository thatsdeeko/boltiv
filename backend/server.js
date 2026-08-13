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
try{resolve(data?JSON.parse(data):{});}
catch(e){reject(e);}
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

function makeUserId(){
return crypto.randomUUID();
}

function hashPassword(password,salt=crypto.randomBytes(16).toString("hex")){
return `${salt}:${crypto.scryptSync(password,salt,64).toString("hex")}`;
}

function verifyPassword(password,stored){
try{
const parts=String(stored||"").split(":");
if(parts.length!==2)return false;
const hash=crypto.scryptSync(password,parts[0],64);
const saved=Buffer.from(parts[1],"hex");
if(hash.length!==saved.length)return false;
return crypto.timingSafeEqual(hash,saved);
}catch(e){
console.error("PASSWORD VERIFY ERROR:",e.message);
return false;
}
}

async function setup(){
if(!DATABASE_URL){
console.log("DATABASE_URL is not configured.");
return;
}

await db(`CREATE TABLE IF NOT EXISTS users(
id BIGSERIAL PRIMARY KEY,
user_id TEXT UNIQUE,
name TEXT,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id TEXT`);
await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);
await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);

const missing=await db(
`SELECT id FROM users WHERE user_id IS NULL`
);

for(const row of missing.rows){
await db(
`UPDATE users SET user_id=$1 WHERE id=$2`,
[makeUserId(),row.id]
);
}

await db(`CREATE UNIQUE INDEX IF NOT EXISTS users_user_id_idx ON users(user_id)`);

await db(`CREATE TABLE IF NOT EXISTS user_sessions(
token TEXT PRIMARY KEY,
user_id BIGINT NOT NULL,
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
admin_id BIGINT NOT NULL,
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
`SELECT id FROM admins WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!r.rows.length){
await db(
`INSERT INTO admins(email,password_hash)
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
ORDER BY date DESC`,
[userId]
);

return r.rows.map(x=>({
...x,
amount:Number(x.amount)
}));
}

async function userFromToken(req){
const h=req.headers.authorization||"";
if(!h.startsWith("Bearer "))return null;

const t=h.slice(7).trim();
if(!t)return null;

const r=await db(
`SELECT u.id,u.user_id,u.email,u.name
FROM user_sessions s
JOIN users u ON u.id=s.user_id
WHERE s.token=$1
AND s.expires_at>NOW()`,
[t]
);

return r.rows[0]||null;
}

async function registerUser(email,password,name=""){
if(!validEmail(email)){
return{
success:false,
message:"Enter a valid email address."
};
}

if(password.length<6){
return{
success:false,
message:"Password must be at least 6 characters."
};
}

const existing=await db(
`SELECT id FROM users
WHERE LOWER(email)=LOWER($1)`,
[email]
);

if(existing.rows.length){
return{
success:false,
message:"An account with this email already exists."
};
}

const userId=makeUserId();

const r=await db(
`INSERT INTO users(
user_id,name,email,password_hash
)
VALUES($1,$2,$3,$4)
RETURNING id,user_id,name,email`,
[
userId,
name||"",
email,
hashPassword(password)
]
);

const user=r.rows[0];

await createWallet(user.user_id);

const t=token();

await db(
`INSERT INTO user_sessions(
token,user_id,expires_at
)
VALUES($1,$2,NOW()+INTERVAL '30 days')`,
[t,user.id]
);

return{
success:true,
message:"Account created successfully.",
token:t,
user:{
id:String(user.user_id),
userId:String(user.user_id),
email:user.email,
name:user.name||""
}
};
  }
async function loginUser(email,password){
if(!validEmail(email)){
return{
success:false,
message:"Enter a valid email address."
};
}

if(!password){
return{
success:false,
message:"Password is required."
};
}

const r=await db(
`SELECT id,user_id,email,name,password_hash
FROM users
WHERE LOWER(email)=LOWER($1)`,
[email]
);

if(!r.rows.length){
return{
success:false,
message:"Invalid email or password."
};
}

const user=r.rows[0];

if(!verifyPassword(password,user.password_hash)){
return{
success:false,
message:"Invalid email or password."
};
}

if(!user.user_id){
user.user_id=makeUserId();

await db(
`UPDATE users
SET user_id=$1
WHERE id=$2`,
[user.user_id,user.id]
);
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
[t,user.id]
);

await createWallet(user.user_id);

return{
success:true,
message:"Login successful.",
token:t,
user:{
id:String(user.user_id),
userId:String(user.user_id),
email:user.email,
name:user.name||""
}
};
}

async function logoutUser(req){
const h=req.headers.authorization||"";

if(h.startsWith("Bearer ")){
await db(
`DELETE FROM user_sessions
WHERE token=$1`,
[h.slice(7).trim()]
);
}

return{
success:true,
message:"Logged out successfully."
};
}

async function admin(req){
const h=req.headers.authorization||"";

if(!h.startsWith("Bearer "))return null;

const t=h.slice(7).trim();

if(!t)return null;

const r=await db(
`SELECT a.id,a.email
FROM admin_sessions s
JOIN admins a ON a.id=s.admin_id
WHERE s.token=$1
AND s.expires_at>NOW()`,
[t]
);

return r.rows[0]||null;
}

async function adminLogin(email,password){
if(!ADMIN_EMAIL||!ADMIN_PASSWORD){
return{
success:false,
message:"Admin environment variables are not configured."
};
}

if(
email.toLowerCase()!==ADMIN_EMAIL.toLowerCase()
){
return{
success:false,
message:"Invalid admin credentials."
};
}

const r=await db(
`SELECT id,email,password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!r.rows.length){
return{
success:false,
message:"Admin account not found."
};
}

const a=r.rows[0];

if(!verifyPassword(password,a.password_hash)){
return{
success:false,
message:"Invalid admin credentials."
};
}

await db(
`DELETE FROM admin_sessions
WHERE expires_at<NOW()`
);

const t=token();

await db(
`INSERT INTO admin_sessions(
token,admin_id,expires_at
)
VALUES($1,$2,NOW()+INTERVAL '24 hours')`,
[t,a.id]
);

return{
success:true,
message:"Admin login successful.",
token:t,
admin:{
id:a.id,
email:a.email
}
};
}

async function paystack(path,options={}){
if(!PAYSTACK_SECRET_KEY){
return{
status:503,
data:{
status:false,
message:"Paystack is not configured."
}
};
}

const r=await fetch(
`https://api.paystack.co${path}`,
{
...options,
headers:{
Authorization:
`Bearer ${PAYSTACK_SECRET_KEY}`,
"Content-Type":"application/json",
...(options.headers||{})
}
}
);

return{
status:r.status,
data:await r.json()
};
}

async function initializePayment(userId,email,amount){
if(!PAYSTACK_SECRET_KEY){
return{
success:false,
message:"Paystack is not configured on the server."
};
}

const ref=reference("BOLTIV-PAY");

const r=await paystack(
"/transaction/initialize",
{
method:"POST",
body:JSON.stringify({
email,
amount:String(
Math.round(amount*100)
),
currency:"NGN",
reference:ref,
callback_url:
`${FRONTEND_URL}/payment-success.html`,
metadata:{
userId,
service:"Wallet Funding"
}
})
}
);

if(!r.data.status){
return{
success:false,
message:r.data.message||
"Unable to initialize payment."
};
}

await db(
`INSERT INTO payments(
reference,user_id,email,amount,
amount_kobo,status,credited
)
VALUES($1,$2,$3,$4,$5,$6,$7)`,
[
ref,
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
message:"Payment initialized.",
reference:ref,
authorizationUrl:
r.data.data.authorization_url,
accessCode:r.data.data.access_code
};
}

async function verifyPayment(ref){
if(!PAYSTACK_SECRET_KEY){
return{
success:false,
message:"Paystack is not configured on the server."
};
}

const p=await db(
`SELECT * FROM payments
WHERE reference=$1`,
[ref]
);

if(!p.rows.length){
return{
success:false,
message:"Payment reference not found."
};
}

const payment=p.rows[0];

if(payment.credited){
const w=await wallet(payment.user_id);

return{
success:true,
alreadyCredited:true,
reference:ref,
balance:w?w.balance:0
};
}

const r=await paystack(
`/transaction/verify/${encodeURIComponent(ref)}`,
{method:"GET"}
);

if(!r.data.status){
return{
success:false,
message:r.data.message||
"Unable to verify payment."
};
}

const t=r.data.data;

if(t.status!=="success"){
await db(
`UPDATE payments
SET status=$1
WHERE reference=$2`,
[t.status,ref]
);

return{
success:false,
message:`Payment status: ${t.status}`,
status:t.status
};
}

if(Number(t.amount)!==
Number(payment.amount_kobo)){
return{
success:false,
message:"Payment amount does not match."
};
  }
