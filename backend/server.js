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
req.on("data",chunk=>data+=chunk);
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

function validEmail(email){
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPhone(phone){
return /^0\d{10}$/.test(phone);
}

function validAmount(amount){
return Number.isFinite(amount)&&amount>0;
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

const hash=crypto.scryptSync(
password,
parts[0],
64
);

const saved=Buffer.from(
parts[1],
"hex"
);

if(hash.length!==saved.length){
return false;
}

return crypto.timingSafeEqual(
hash,
saved
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
console.log(
"DATABASE_URL is not configured."
);
return;
}

await db(`
CREATE TABLE IF NOT EXISTS users(
id BIGSERIAL PRIMARY KEY,
user_id TEXT UNIQUE,
name TEXT,
phone TEXT,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS user_id TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS name TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS phone TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_hash TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
);

const missing=await db(
`SELECT id FROM users
WHERE user_id IS NULL`
);

for(const row of missing.rows){

await db(
`UPDATE users
SET user_id=$1
WHERE id=$2`,
[
makeUserId(),
row.id
]
);
}

const missingPhones=await db(
`SELECT id FROM users
WHERE phone IS NULL`
);

for(const row of missingPhones.rows){

await db(
`UPDATE users
SET phone=$1
WHERE id=$2`,
[
"00000000000",
row.id
]
);
}

await db(`
CREATE UNIQUE INDEX IF NOT EXISTS
users_user_id_idx
ON users(user_id)
`);

await db(`
CREATE TABLE IF NOT EXISTS user_sessions(
token TEXT PRIMARY KEY,
user_id BIGINT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)`);

await db(`
CREATE TABLE IF NOT EXISTS wallets(
user_id TEXT PRIMARY KEY,
balance NUMERIC(14,2) NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

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
)`);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS provider_reference TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS phone TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS network TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS plan TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS meter_number TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS meter_type TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS smartcard_number TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS cable_package TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS provider TEXT`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS response_data JSONB`
);

await db(
`ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`
);

await db(
`UPDATE transactions
SET created_at=date
WHERE created_at IS NULL`
);
 await db(`
CREATE TABLE IF NOT EXISTS payments(
id BIGSERIAL PRIMARY KEY,
reference TEXT UNIQUE NOT NULL,
user_id TEXT NOT NULL,
email TEXT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
amount_kobo BIGINT NOT NULL,
status TEXT NOT NULL,
credited BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
credited_at TIMESTAMPTZ
)`);

await db(`
CREATE TABLE IF NOT EXISTS admins(
id BIGSERIAL PRIMARY KEY,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS admin_sessions(
token TEXT PRIMARY KEY,
admin_id BIGINT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)`);

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
`SELECT user_id,balance,
created_at,updated_at
FROM wallets
WHERE user_id=$1`,
[userId]
);

if(!r.rows.length){
return null;
}

return{
...r.rows[0],
balance:Number(r.rows[0].balance)
};
}

async function transactions(userId){
const r=await db(
`SELECT *
FROM transactions
WHERE user_id=$1
ORDER BY date DESC
LIMIT 100`,
[userId]
);

return r.rows.map(x=>({
...x,
amount:Number(x.amount)
}));
}

async function userFromToken(req){
const h=req.headers.authorization||"";

if(!h.startsWith("Bearer ")){
return null;
}

const t=h.slice(7).trim();

if(!t){
return null;
}

const r=await db(
`SELECT
u.id,
u.user_id,
u.name,
u.phone,
u.email
FROM user_sessions s
JOIN users u
ON u.id=s.user_id
WHERE s.token=$1
AND s.expires_at>NOW()`,
[t]
);

return r.rows[0]||null;
}

async function registerUser(
email,
password,
name,
phone
){

if(!name||name.length<2){
return{
success:false,
message:"Please enter your full name."
};
}

if(!validPhone(phone)){
return{
success:false,
message:
"Please enter a valid Nigerian phone number."
};
}

if(!validEmail(email)){
return{
success:false,
message:"Enter a valid email address."
};
}

if(password.length<6){
return{
success:false,
message:
"Password must be at least 6 characters."
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
message:
"An account with this email already exists."
};
}

const userId=makeUserId();
const passwordHash=hashPassword(password);

const r=await db(
`INSERT INTO users(
user_id,
name,
phone,
email,
password_hash,
updated_at
)
VALUES($1,$2,$3,$4,$5,NOW())
RETURNING id,user_id,name,phone,email`,
[
userId,
name,
phone,
email,
passwordHash
]
);

const user=r.rows[0];

await createWallet(user.user_id);

const sessionToken=token();

await db(
`INSERT INTO user_sessions(
token,
user_id,
expires_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '30 days'
)`,
[
sessionToken,
user.id
]
);

return{
success:true,
message:
"Account created successfully.",
token:sessionToken,
user:{
id:String(user.user_id),
userId:String(user.user_id),
name:user.name,
phone:user.phone,
email:user.email
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
`SELECT
id,
user_id,
name,
phone,
email,
password_hash
FROM users
WHERE LOWER(email)=LOWER($1)`,
[email]
);

if(!r.rows.length){
return{
success:false,
message:
"Invalid email or password."
};
}

const user=r.rows[0];

if(!verifyPassword(
password,
user.password_hash
)){
return{
success:false,
message:
"Invalid email or password."
};
}

if(!user.user_id){
user.user_id=makeUserId();

await db(
`UPDATE users
SET user_id=$1
WHERE id=$2`,
[
user.user_id,
user.id
]
);
}

if(!user.phone){
return{
success:false,
message:
"Your account is missing a phone number."
};
}

await createWallet(user.user_id);

await db(
`DELETE FROM user_sessions
WHERE expires_at<NOW()`
);

const sessionToken=token();

await db(
`INSERT INTO user_sessions(
token,
user_id,
expires_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '30 days'
)`,
[
sessionToken,
user.id
]
);

return{
success:true,
message:"Login successful.",
token:sessionToken,
user:{
id:String(user.user_id),
userId:String(user.user_id),
name:user.name||"",
phone:user.phone||"",
email:user.email
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

const passwordHash=
hashPassword(ADMIN_PASSWORD);

const created=await db(
`INSERT INTO admins(
email,password_hash
)
VALUES($1,$2)
RETURNING id,email`,
[
ADMIN_EMAIL,
passwordHash
]
);

const admin=created.rows[0];
const sessionToken=token();

await db(
`INSERT INTO admin_sessions(
token,admin_id,expires_at
)
VALUES(
$1,$2,NOW()+INTERVAL '24 hours'
)`,
[
sessionToken,
admin.id
]
);

return{
success:true,
message:
"Admin login successful.",
token:sessionToken,
admin:{
id:admin.id,
email:admin.email
}
};
}

const admin=r.rows[0];

if(!verifyPassword(
password,
admin.password_hash
)){

return{
success:false,
message:
"Invalid admin credentials."
};
}

await db(
`DELETE FROM admin_sessions
WHERE expires_at<NOW()`
);

const sessionToken=token();

await db(
`INSERT INTO admin_sessions(
token,admin_id,expires_at
)
VALUES(
$1,$2,NOW()+INTERVAL '24 hours'
)`,
[
sessionToken,
admin.id
]
);

return{
success:true,
message:
"Admin login successful.",
token:sessionToken,
admin:{
id:admin.id,
email:admin.email
}
};
}

async function adminFromToken(req){

const h=req.headers.authorization||"";

if(!h.startsWith("Bearer ")){
return null;
}

const t=h.slice(7).trim();

if(!t){
return null;
}

const r=await db(
`SELECT
a.id,
a.email
FROM admin_sessions s
JOIN admins a
ON a.id=s.admin_id
WHERE s.token=$1
AND s.expires_at>NOW()`,
[t]
);

return r.rows[0]||null;
}

async function paystack(path,options={}){

if(!PAYSTACK_SECRET_KEY){

return{
status:503,
data:{
status:false,
message:
"Paystack is not configured."
}
};
}

const response=await fetch(
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

let data={};

try{
data=await response.json();
}catch(error){
data={
status:false,
message:
"Invalid Paystack response."
};
}

return{
status:response.status,
data
};
}

async function initializePayment(
userId,
email,
amount
){

if(!PAYSTACK_SECRET_KEY){

return{
success:false,
message:
"Paystack is not configured on the server."
};
}

const ref=
reference("BOLTIV-PAY");

const result=await paystack(
"/transaction/initialize",
{
method:"POST",
body:JSON.stringify({
email,
amount:Math.round(
amount*100
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

if(!result.data.status){

return{
success:false,
message:
result.data.message||
"Unable to initialize payment."
};
}

await db(
`INSERT INTO payments(
reference,
user_id,
email,
amount,
amount_kobo,
status,
credited
)
VALUES(
$1,$2,$3,$4,$5,$6,$7
)`,
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
message:
"Payment initialized.",
reference:ref,
authorizationUrl:
result.data.data.authorization_url,
accessCode:
result.data.data.access_code
};
}

async function verifyPayment(ref){

if(!PAYSTACK_SECRET_KEY){

return{
success:false,
message:
"Paystack is not configured on the server."
};
}

const found=await db(
`SELECT *
FROM payments
WHERE reference=$1`,
[ref]
);

if(!found.rows.length){

return{
success:false,
message:
"Payment reference not found."
};
}

const payment=found.rows[0];

if(payment.credited){

const w=
await wallet(payment.user_id);

return{
success:true,
alreadyCredited:true,
reference:ref,
balance:w?w.balance:0
};
}

const result=await paystack(
`/transaction/verify/${encodeURIComponent(ref)}`,
{
method:"GET"
}
);

if(!result.data.status){

return{
success:false,
message:
result.data.message||
"Unable to verify payment."
};
}

const transaction=
result.data.data;

if(transaction.status!=="success"){

await db(
`UPDATE payments
SET status=$1
WHERE reference=$2`,
[
transaction.status,
ref
]
);

return{
success:false,
message:
`Payment status: ${transaction.status}`,
status:transaction.status
};
}

if(
Number(transaction.amount)!==
Number(payment.amount_kobo)
){

return{
success:false,
message:
"Payment amount does not match."
};
 }
 const client=await pool.connect();

try{

await client.query("BEGIN");

await client.query(
`INSERT INTO wallets(
user_id,balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[payment.user_id]
);

const updated=await client.query(
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
user_id,
type,
service,
amount,
reference,
status,
date
)
VALUES(
$1,
'credit',
'Wallet Funding',
$2,
$3,
'successful',
NOW()
)
ON CONFLICT(reference)
DO NOTHING`,
[
payment.user_id,
Number(payment.amount),
ref
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
message:
"Wallet funded successfully.",
reference:ref,
amount:Number(payment.amount),
balance:Number(
updated.rows[0].balance
)
};

}catch(error){

await client.query("ROLLBACK");
throw error;

}finally{

client.release();
}
}

async function debitWallet(
userId,
amount
){

const client=await pool.connect();

try{

await client.query("BEGIN");

await client.query(
`INSERT INTO wallets(
user_id,balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[userId]
);

const r=await client.query(
`UPDATE wallets
SET balance=balance-$1,
updated_at=NOW()
WHERE user_id=$2
AND balance >= $1
RETURNING balance`,
[
amount,
userId
]
);

if(!r.rows.length){

await client.query("ROLLBACK");

return{
success:false,
message:
"Insufficient wallet balance."
};
}

await client.query("COMMIT");

return{
success:true,
balance:Number(
r.rows[0].balance
)
};

}catch(error){

await client.query("ROLLBACK");
throw error;

}finally{

client.release();
}
}

async function refundWallet(
userId,
amount
){

await db(
`UPDATE wallets
SET balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2`,
[
amount,
userId
]
);
}

async function insertTransaction(data){

await db(
`INSERT INTO transactions(
user_id,
type,
service,
amount,
reference,
status,
provider_reference,
phone,
network,
plan,
meter_number,
meter_type,
smartcard_number,
cable_package,
provider,
response_data,
date
)
VALUES(
$1,$2,$3,$4,$5,$6,$7,$8,
$9,$10,$11,$12,$13,$14,$15,$16,NOW()
)
ON CONFLICT(reference)
DO NOTHING`,
[
data.userId,
data.type||"debit",
data.service,
data.amount,
data.reference,
data.status,
data.providerReference||null,
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
}

async function callVTUProvider(
payload
){

if(!VTU_API_URL||
!VTU_API_KEY){

return{
success:false,
configured:false,
message:
"VTU provider is not configured."
};
}

const response=await fetch(
VTU_API_URL,
{
method:"POST",
headers:{
"Content-Type":"application/json",
Authorization:
`Bearer ${VTU_API_KEY}`
},
body:JSON.stringify(payload)
}
);

let data={};

try{
data=await response.json();
}catch(error){
data={};
}

return{
success:response.ok,
configured:true,
status:response.status,
data
};
}

async function processVTUService(data){

const userId=clean(data.userId);
const amount=Number(data.amount);

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

const current=await wallet(userId);

if(!current||
Number(current.balance)<amount){

return{
success:false,
statusCode:400,
message:"Insufficient wallet balance.",
balance:current?
Number(current.balance):0
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

let providerResult;

try{

providerResult=
await callVTUProvider(
data.providerPayload
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
message:
"VTU provider connection failed."
};
}

if(!providerResult.configured){

await refundWallet(
userId,
amount
);

return{
success:false,
statusCode:503,
message:
providerResult.message
};
}

const providerData=
providerResult.data||{};

const providerReference=
providerData.reference||
providerData.transaction_id||
providerData.transactionId||
null;

if(!providerResult.success){

await refundWallet(
userId,
amount
);

await insertTransaction({
userId,
service:data.service,
amount,
reference:ref,
status:"failed",
providerReference,
phone:data.phone,
network:data.network,
plan:data.plan,
meterNumber:data.meterNumber,
meterType:data.meterType,
smartcardNumber:data.smartcardNumber,
cablePackage:data.cablePackage,
provider:data.provider,
responseData:providerData
});

return{
success:false,
statusCode:400,
message:
"VTU transaction failed.",
reference:ref,
balance:
Number((await wallet(userId)).balance)
};
}

await insertTransaction({
userId,
service:data.service,
amount,
reference:ref,
status:"successful",
providerReference,
phone:data.phone,
network:data.network,
plan:data.plan,
meterNumber:data.meterNumber,
meterType:data.meterType,
smartcardNumber:data.smartcardNumber,
cablePackage:data.cablePackage,
provider:data.provider,
responseData:providerData
});

const finalWallet=
await wallet(userId);

return{
success:true,
message:
`${data.service} purchase successful.`,
reference:ref,
providerReference,
service:data.service,
amount,
status:"successful",
balance:
finalWallet?
Number(finalWallet.balance):0,
data:providerData
};
}
