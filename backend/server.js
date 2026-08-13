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
return `${salt}:${crypto.scryptSync(password,salt,64).toString("hex")}`;
}

function verifyPassword(password,stored){
try{
const [salt,key]=String(stored||"").split(":");
if(!salt||!key)return false;
const hash=crypto.scryptSync(password,salt,64);
const saved=Buffer.from(key,"hex");
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
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);

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
`SELECT id FROM admins WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!r.rows.length){
await db(
`INSERT INTO admins(email,password_hash) VALUES($1,$2)`,
[ADMIN_EMAIL,hashPassword(ADMIN_PASSWORD)]
);
console.log("Admin account created.");
}else{
await db(
`UPDATE admins SET email=$1,password_hash=$2 WHERE id=$3`,
[ADMIN_EMAIL,hashPassword(ADMIN_PASSWORD),r.rows[0].id]
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
`SELECT u.id,u.email,u.name
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

const r=await db(
`INSERT INTO users(email,password_hash,name)
VALUES($1,$2,$3)
RETURNING id,email,name`,
[email,hashPassword(password),name||null]
);

const user=r.rows[0];

await createWallet(String(user.id));

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
id:String(user.id),
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
`SELECT id,email,name,password_hash
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

await createWallet(String(user.id));

return{
success:true,
message:"Login successful.",
token:t,
user:{
id:String(user.id),
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

async function paystack(path,options={}){
const r=await fetch(
`https://api.paystack.co${path}`,
{
...options,
headers:{
Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,
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
amount:String(Math.round(amount*100)),
currency:"NGN",
reference:ref,
callback_url:
`${FRONTEND_URL}/payment-success.html`,
metadata:{
userId,
service:"BOLTIV Wallet Funding"
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
`UPDATE payments SET status=$1
WHERE reference=$2`,
[t.status,ref]
);

return{
success:false,
message:`Payment status: ${t.status}`,
status:t.status
};
}

if(t.currency!=="NGN"){
return{
success:false,
message:"Invalid payment currency."
};
}

if(Number(t.amount)!==
Number(payment.amount_kobo)){
return{
success:false,
message:"Payment amount does not match."
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

const w=await client.query(
`UPDATE wallets
SET balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2
RETURNING balance`,
[
Number(payment.amount),
payment.user_id
]
);

await client.query(
`INSERT INTO transactions(
user_id,type,service,amount,
reference,status
)
VALUES($1,$2,$3,$4,$5,$6)
ON CONFLICT(reference) DO NOTHING`,
[
payment.user_id,
"credit",
"Wallet Funding",
Number(payment.amount),
ref,
"successful"
]
);

await client.query(
`UPDATE payments
SET status='success',
credited=TRUE,
credited_at=NOW()
WHERE reference=$1`,
[ref]
);

await client.query("COMMIT");

return{
success:true,
message:"Wallet funded successfully.",
reference:ref,
amount:Number(payment.amount),
balance:Number(w.rows[0].balance)
};

}catch(error){

await client.query("ROLLBACK");
throw error;

}finally{

client.release();

}
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
message:
"Admin environment variables are not configured."
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

if(
email.toLowerCase()!==ADMIN_EMAIL.toLowerCase()||
!verifyPassword(password,a.password_hash)
){
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

async function callVTUProvider(payload){

if(!VTU_API_URL||!VTU_API_KEY){
return{
success:false,
configured:false,
message:
"VTU provider is not configured on the server."
};
}

const r=await fetch(
VTU_API_URL,
{
method:"POST",
headers:{
"Content-Type":"application/json",
Authorization:`Bearer ${VTU_API_KEY}`
},
body:JSON.stringify(payload)
}
);

let data;

try{
data=await r.json();
}catch{
data={};
}

return{
success:r.ok,
configured:true,
httpStatus:r.status,
data
};
}

async function insertTransaction(client,data){

const r=await client.query(
`INSERT INTO transactions(
user_id,type,service,amount,reference,
provider_reference,status,phone,network,plan,
meter_number,meter_type,smartcard_number,
cable_package,provider,response_data
)
VALUES(
$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
$11,$12,$13,$14,$15,$16
)
RETURNING id`,
[
data.userId,
data.type||"debit",
data.service,
data.amount,
data.reference,
data.providerReference||null,
data.status,
data.phone||null,
data.network||null,
data.plan||null,
data.meterNumber||null,
data.meterType||null,
data.smartcardNumber||null,
data.cablePackage||null,
data.provider||null,
data.responseData||null
]
);

return r.rows[0];
}

async function debitWallet(userId,amount){

const client=await pool.connect();

try{

await client.query("BEGIN");

await client.query(
`INSERT INTO wallets(user_id,balance)
VALUES($1,0)
ON CONFLICT(user_id) DO NOTHING`,
[userId]
);

const r=await client.query(
`UPDATE wallets
SET balance=balance-$1,
updated_at=NOW()
WHERE user_id=$2
AND balance >= $1
RETURNING balance`,
[amount,userId]
);

if(!r.rows.length){

await client.query("ROLLBACK");

return{
success:false,
message:"Insufficient wallet balance."
};
}

await client.query("COMMIT");

return{
success:true,
balance:Number(r.rows[0].balance)
};

}catch(error){

await client.query("ROLLBACK");
throw error;

}finally{

client.release();

}
}

async function refundWallet(userId,amount){

await db(
`UPDATE wallets
SET balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2`,
[amount,userId]
);
}

async function processVTUService(data){

const{
userId,service,amount,provider,
providerPayload,phone,network,plan,
meterNumber,meterType,
smartcardNumber,cablePackage
}=data;

if(!userId){
return{
success:false,
statusCode:400,
message:"User ID is required."
};
}

if(!validAmount(amount)){
return{
success:false,
statusCode:400,
message:"Invalid amount."
};
}

await createWallet(userId);

const w=await wallet(userId);

if(!w||w.balance<amount){
return{
success:false,
statusCode:400,
message:"Insufficient wallet balance.",
balance:w?w.balance:0
};
}

const ref=reference("BOLTIV-TX");

const debit=await debitWallet(
userId,
amount
);

if(!debit.success){
return{
success:false,
statusCode:400,
message:debit.message
};
}

let result;

try{
result=await callVTUProvider(
providerPayload
);
}catch(error){

console.error(
"VTU PROVIDER ERROR:",
error
);

await refundWallet(
userId,
amount
);

return{
success:false,
statusCode:502,
message:"VTU provider connection failed."
};
}

if(!result.configured){

await refundWallet(
userId,
amount
);

return{
success:false,
statusCode:503,
message:result.message
};
}
if(!result.success){

await refundWallet(
userId,
amount
);

const client=await pool.connect();

try{

await insertTransaction(
client,
{
userId,
service,
amount,
reference:ref,
status:"failed",
phone,
network,
plan,
meterNumber,
meterType,
smartcardNumber,
cablePackage,
provider,
responseData:result.data
}
);

}finally{

client.release();

}

const fw=await wallet(userId);

return{
success:false,
statusCode:400,
message:"VTU transaction failed.",
reference:ref,
balance:fw?fw.balance:0
};
}

const providerData=result.data||{};

const providerReference=
providerData.reference||
providerData.transaction_id||
providerData.transactionId||
null;

const client=await pool.connect();

try{

await insertTransaction(
client,
{
userId,
service,
amount,
reference:ref,
providerReference,
status:"successful",
phone,
network,
plan,
meterNumber,
meterType,
smartcardNumber,
cablePackage,
provider,
responseData:providerData
}
);

}finally{

client.release();

}

const finalWallet=await wallet(userId);

return{
success:true,
message:`${service} purchase successful.`,
reference:ref,
providerReference,
service,
amount,
status:"successful",
balance:finalWallet?
finalWallet.balance:0,
data:providerData
};
}

const server=http.createServer(
async(req,res)=>{

res.setHeader(
"Access-Control-Allow-Origin",
"*"
);

res.setHeader(
"Access-Control-Allow-Methods",
"GET,POST,OPTIONS"
);

res.setHeader(
"Access-Control-Allow-Headers",
"Content-Type,Authorization"
);

if(req.method==="OPTIONS"){

res.writeHead(204);
return res.end();

}

const url=new URL(
req.url,
"http://localhost"
);

const path=url.pathname;

try{

if(
req.method==="GET"&&
path==="/api/health"
){

return send(res,200,{
success:true,
app:"BOLTIV",
status:"online",
paystack:
PAYSTACK_SECRET_KEY?
"configured":
"not configured",
database:
DATABASE_URL?
"configured":
"not configured",
vtu:
VTU_API_URL&&VTU_API_KEY?
"configured":
"not configured",
admin:
ADMIN_EMAIL&&ADMIN_PASSWORD?
"configured":
"not configured",
message:
"BOLTIV backend is running"
});

}

if(
req.method==="POST"&&
path==="/api/auth/register"
){

const b=await body(req);

const email=clean(b.email)
.toLowerCase();

const password=String(
b.password||""
);

const name=clean(
b.name||b.fullName
);

const result=
await registerUser(
email,
password,
name
);

return send(
res,
result.success?200:400,
result
);

}

if(
req.method==="POST"&&
path==="/api/auth/login"
){

const b=await body(req);

const email=clean(b.email)
.toLowerCase();

const password=String(
b.password||""
);

const result=
await loginUser(
email,
password
);

return send(
res,
result.success?200:401,
result
);

}

if(
req.method==="GET"&&
path==="/api/auth/me"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:"Unauthorized."
});

}

return send(res,200,{
success:true,
user:{
id:String(user.id),
email:user.email,
name:user.name||""
}
});

}

if(
req.method==="POST"&&
path==="/api/auth/logout"
){

return send(
res,
200,
await logoutUser(req)
);

}

if(
req.method==="POST"&&
path==="/api/wallet/create"
){

const b=await body(req);

const userId=clean(b.userId);

if(!userId){

return send(res,400,{
success:false,
message:"User ID is required."
});

}

await createWallet(userId);

const w=await wallet(userId);

return send(res,200,{
success:true,
message:"Wallet ready.",
userId,
balance:w?w.balance:0
});

}

if(
req.method==="GET"&&
path==="/api/wallet"
){

const userId=clean(
url.searchParams.get(
"userId"
)
);

if(!userId){

return send(res,400,{
success:false,
message:"User ID is required."
});

}

const w=await wallet(userId);

if(!w){

return send(res,404,{
success:false,
message:"Wallet not found."
});

}

return send(res,200,{
success:true,
userId,
balance:w.balance,
transactions:
await transactions(userId)
});

}

if(
req.method==="POST"&&
path==="/api/wallet/fund"
){

const b=await body(req);

const userId=clean(b.userId);
const email=clean(b.email);
const amount=Number(b.amount);

if(!userId){

return send(res,400,{
success:false,
message:"User ID is required."
});

}

if(!validEmail(email)){

return send(res,400,{
success:false,
message:"A valid email is required."
});

}

if(!Number.isFinite(amount)||amount<100){

return send(res,400,{
success:false,
message:
"Minimum wallet funding amount is ₦100."
});

}

await createWallet(userId);

const result=
await initializePayment(
userId,
email,
amount
);

return send(
res,
result.success?200:400,
result
);

}

if(
req.method==="GET"&&
path==="/api/wallet/verify"
){

const ref=clean(
url.searchParams.get(
"reference"
)
);

if(!ref){

return send(res,400,{
success:false,
message:"Payment reference is required."
});

}

const result=
await verifyPayment(ref);

return send(
res,
result.success?200:400,
result
);

  }
