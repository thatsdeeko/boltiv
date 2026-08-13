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

function hashPassword(password,salt=crypto.randomBytes(16).toString("hex")){
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
phone TEXT NOT NULL,
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
await db(
`UPDATE users
SET user_id=COALESCE(
NULLIF(user_id,''),
gen_random_uuid()::text
)
WHERE user_id IS NULL
OR user_id=''`
);

await db(
`UPDATE users
SET updated_at=COALESCE(
updated_at,
created_at,
NOW()
)
WHERE updated_at IS NULL`
);

await db(
`CREATE UNIQUE INDEX IF NOT EXISTS
users_email_lower_idx
ON users(LOWER(email))`
);

await db(
`ALTER TABLE users
ALTER COLUMN user_id SET NOT NULL`
);

await db(
`ALTER TABLE users
ALTER COLUMN phone SET NOT NULL`
);

await db(
`CREATE UNIQUE INDEX IF NOT EXISTS
users_user_id_idx
ON users(user_id)`
);

console.log("DATABASE SETUP COMPLETE");
}

async function createWallet(userId){

await db(
`INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[userId]
);

}

async function getWallet(userId){

const result=await db(
`SELECT
user_id,
balance,
created_at,
updated_at
FROM wallets
WHERE user_id=$1`,
[userId]
);

if(!result.rows.length){
return null;
}

return{
...result.rows[0],
balance:Number(
result.rows[0].balance
)
};

}

async function getTransactions(userId){

const result=await db(
`SELECT *
FROM transactions
WHERE user_id=$1
ORDER BY date DESC
LIMIT 100`,
[userId]
);

return result.rows.map(item=>({
...item,
amount:Number(item.amount)
}));

}

async function userFromToken(req){

const authorization=
req.headers.authorization||"";

if(!authorization.startsWith(
"Bearer "
)){
return null;
}

const sessionToken=
authorization.slice(7).trim();

if(!sessionToken){
return null;
}

const result=await db(
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
[sessionToken]
);

return result.rows[0]||null;

}

async function registerUser(
email,
password,
name,
phone
){

email=clean(email).toLowerCase();
password=String(password||"");
name=clean(name);
phone=clean(phone);

if(name.length<2){

return{
success:false,
message:
"Please enter your full name."
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
message:
"Please enter a valid email address."
};

}

if(password.length<6){

return{
success:false,
message:
"Password must contain at least 6 characters."
};

}

const existing=await db(
`SELECT id
FROM users
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

const passwordHash=
hashPassword(password);

const result=await db(
`INSERT INTO users(
user_id,
name,
phone,
email,
password_hash,
created_at,
updated_at
)
VALUES(
$1,$2,$3,$4,$5,NOW(),NOW()
)
RETURNING
id,
user_id,
name,
phone,
email`,
[
userId,
name,
phone,
email,
passwordHash
]
);

const user=result.rows[0];

await createWallet(
user.user_id
);

return{
success:true,
message:
"Account created successfully.",
user:{
id:user.user_id,
userId:user.user_id,
name:user.name,
phone:user.phone,
email:user.email
}
};

}

async function loginUser(
email,
password
){

email=clean(email).toLowerCase();
password=String(password||"");

const result=await db(
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

if(!result.rows.length){

return{
success:false,
message:
"Invalid email or password."
};

}

const user=result.rows[0];

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

user.user_id=
makeUserId();

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

await createWallet(
user.user_id
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
id:user.user_id,
userId:user.user_id,
name:user.name||"",
phone:user.phone||"",
email:user.email
}
};

}

async function logoutUser(req){

const authorization=
req.headers.authorization||"";

if(authorization.startsWith(
"Bearer "
)){

await db(
`DELETE FROM user_sessions
WHERE token=$1`,
[
authorization.slice(7).trim()
]
);

}

return{
success:true,
message:
"Logged out successfully."
};

}
async function adminLogin(
email,
password
){

email=clean(email).toLowerCase();
password=String(password||"");

if(!ADMIN_EMAIL||
!ADMIN_PASSWORD){

return{
success:false,
message:
"Admin environment variables are not configured."
};

}

let result=await db(
`SELECT
id,
email,
password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!result.rows.length){

const passwordHash=
hashPassword(ADMIN_PASSWORD);

result=await db(
`INSERT INTO admins(
email,
password_hash
)
VALUES($1,$2)
RETURNING id,email,password_hash`,
[
ADMIN_EMAIL,
passwordHash
]
);

}

const admin=result.rows[0];

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
token,
admin_id,
expires_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '24 hours'
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

const authorization=
req.headers.authorization||"";

if(!authorization.startsWith(
"Bearer "
)){
return null;
}

const sessionToken=
authorization.slice(7).trim();

const result=await db(
`SELECT
a.id,
a.email
FROM admin_sessions s
JOIN admins a
ON a.id=s.admin_id
WHERE s.token=$1
AND s.expires_at>NOW()`,
[sessionToken]
);

return result.rows[0]||null;

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

const referenceValue=
reference("BOLTIV-PAY");

const response=await fetch(
"https://api.paystack.co/transaction/initialize",
{
method:"POST",
headers:{
Authorization:
`Bearer ${PAYSTACK_SECRET_KEY}`,
"Content-Type":
"application/json"
},
body:JSON.stringify({
email,
amount:Math.round(
amount*100
),
currency:"NGN",
reference:referenceValue,
callback_url:
`${FRONTEND_URL}/payment-success.html`,
metadata:{
userId
}
})
}
);

const data=await response.json();

if(!response.ok||
!data.status){

return{
success:false,
message:
data.message||
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
$1,$2,$3,$4,$5,
'initialized',
FALSE
)`,
[
referenceValue,
userId,
email,
amount,
Math.round(amount*100)
]
);

return{
success:true,
message:
"Payment initialized.",
reference:
referenceValue,
authorizationUrl:
data.data.authorization_url,
accessCode:
data.data.access_code
};

}

async function verifyPayment(
referenceValue
){

if(!PAYSTACK_SECRET_KEY){

return{
success:false,
message:
"Paystack is not configured on the server."
};

}

const paymentResult=await db(
`SELECT *
FROM payments
WHERE reference=$1`,
[referenceValue]
);

if(!paymentResult.rows.length){

return{
success:false,
message:
"Payment reference not found."
};

}

const payment=
paymentResult.rows[0];

if(payment.credited){

const currentWallet=
await getWallet(
payment.user_id
);

return{
success:true,
alreadyCredited:true,
reference:
referenceValue,
balance:
currentWallet?
currentWallet.balance:0
};

}

const response=await fetch(
`https://api.paystack.co/transaction/verify/${encodeURIComponent(referenceValue)}`,
{
method:"GET",
headers:{
Authorization:
`Bearer ${PAYSTACK_SECRET_KEY}`
}
}
);

const data=await response.json();

if(!response.ok||
!data.status){

return{
success:false,
message:
data.message||
"Unable to verify payment."
};

}

const transaction=data.data;

if(transaction.status!=="success"){

await db(
`UPDATE payments
SET status=$1
WHERE reference=$2`,
[
transaction.status,
referenceValue
]
);

return{
success:false,
message:
`Payment status: ${transaction.status}`,
status:
transaction.status
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

const client=
await pool.connect();

try{

await client.query("BEGIN");

await client.query(
`INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[payment.user_id]
);

const walletResult=
await client.query(
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
referenceValue
]
);

await client.query(
`UPDATE payments
SET
status='success',
credited=TRUE,
credited_at=NOW()
WHERE reference=$1`,
[referenceValue]
);

await client.query("COMMIT");

return{
success:true,
message:
"Wallet funded successfully.",
reference:
referenceValue,
amount:
Number(payment.amount),
balance:
Number(walletResult.rows[0].balance)
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

const result=await client.query(
`UPDATE wallets
SET
balance=balance-$1,
updated_at=NOW()
WHERE user_id=$2
AND balance>=$1
RETURNING balance`,
[
amount,
userId
]
);

if(!result.rows.length){

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
balance:
Number(result.rows[0].balance)
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
SET
balance=balance+$1,
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
date
)
VALUES(
$1,$2,$3,$4,$5,$6,NOW()
)
ON CONFLICT(reference)
DO NOTHING`,
[
data.userId,
data.type||"debit",
data.service,
data.amount,
data.reference,
data.status
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
"Content-Type":
"application/json",
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

async function processVTUService(
data
){

const userId=clean(data.userId);
const amount=Number(data.amount);

if(!userId){

return{
success:false,
statusCode:400,
message:
"User ID is required."
};

}

if(!validAmount(amount)){

return{
success:false,
statusCode:400,
message:
"Invalid amount."
};

}

await createWallet(userId);

const current=
await getWallet(userId);

if(!current||
current.balance<amount){

return{
success:false,
statusCode:400,
message:
"Insufficient wallet balance.",
balance:
current?current.balance:0
};

}

const referenceValue=
reference("BOLTIV-TX");

const debit=
await debitWallet(
userId,
amount
);

if(!debit.success){

return{
success:false,
statusCode:400,
message:
debit.message
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

if(!providerResult.success){

await refundWallet(
userId,
amount
);

await insertTransaction({
userId,
service:data.service,
amount,
reference:referenceValue,
status:"failed"
});

return{
success:false,
statusCode:400,
message:
"VTU transaction failed.",
reference:
referenceValue,
balance:
(await getWallet(userId)).balance
};

}

await insertTransaction({
userId,
service:data.service,
amount,
reference:referenceValue,
status:"successful"
});

const finalWallet=
await getWallet(userId);

return{
success:true,
message:
`${data.service} purchase successful.`,
reference:
referenceValue,
amount,
status:"successful",
balance:
finalWallet?
finalWallet.balance:0,
data:providerData
};

}
const server=http.createServer(
async(req,res)=>{

if(req.method==="OPTIONS"){

res.writeHead(204,{
"Access-Control-Allow-Origin":"*",
"Access-Control-Allow-Methods":
"GET,POST,OPTIONS",
"Access-Control-Allow-Headers":
"Content-Type,Authorization"
});

return res.end();
}

try{

const url=new URL(
req.url,
`http://${req.headers.host||"localhost"}`
);

const path=url.pathname;

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

const name=clean(
b.name||b.fullName
);

const phone=clean(
b.phone||b.phoneNumber
);

const email=clean(
b.email
).toLowerCase();

const password=
String(b.password||"");

const result=
await registerUser(
email,
password,
name,
phone
);

return send(
res,
result.success?201:400,
result
);

}

if(
req.method==="POST"&&
path==="/api/auth/login"
){

const b=await body(req);

const email=clean(
b.email
).toLowerCase();

const password=
String(b.password||"");

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
req.method==="POST"&&
path==="/api/auth/logout"
){

const result=
await logoutUser(req);

return send(res,200,result);

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
message:
"Unauthorized."
});

}

return send(res,200,{
success:true,
user
});

}

if(
req.method==="GET"&&
path==="/api/wallet"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

await createWallet(
user.user_id
);

const wallet=
await getWallet(
user.user_id
);

return send(res,200,{
success:true,
wallet
});

}

if(
req.method==="GET"&&
path==="/api/transactions"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const transactions=
await getTransactions(
user.user_id
);

return send(res,200,{
success:true,
transactions
});

}

if(
req.method==="POST"&&
path==="/api/payments/initialize"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const b=await body(req);

const amount=Number(
b.amount
);

if(!validAmount(amount)){

return send(res,400,{
success:false,
message:
"Invalid payment amount."
});

}

const result=
await initializePayment(
user.user_id,
user.email,
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
path==="/api/payments/verify"
){

const referenceValue=
clean(
url.searchParams.get(
"reference"
)
);

if(!referenceValue){

return send(res,400,{
success:false,
message:
"Payment reference is required."
});

}

const result=
await verifyPayment(
referenceValue
);

return send(
res,
result.success?200:400,
result
);

}

if(
req.method==="POST"&&
path==="/api/paystack/webhook"
){

if(!PAYSTACK_SECRET_KEY){

return send(res,503,{
success:false,
message:
"Paystack is not configured."
});

}

const signature=
req.headers["x-paystack-signature"];

const rawBody=
await new Promise(
(resolve,reject)=>{

let data="";

req.on(
"data",
chunk=>{
data+=chunk;
}
);

req.on(
"end",
()=>resolve(data)
);

req.on(
"error",
reject
);

});

const expected=
crypto.createHmac(
"sha512",
PAYSTACK_SECRET_KEY
)
.update(rawBody)
.digest("hex");

if(
!signature||
signature!==expected
){

return send(res,401,{
success:false,
message:
"Invalid webhook signature."
});

}

let event;

try{

event=JSON.parse(rawBody);

}catch(error){

return send(res,400,{
success:false,
message:
"Invalid webhook payload."
});

}

if(
event.event===
"charge.success"
){

const referenceValue=
event.data&&
event.data.reference;

if(referenceValue){

try{

await verifyPayment(
referenceValue
);

}catch(error){

console.error(
"WEBHOOK VERIFY ERROR:",
error
);

}

}

}

return send(res,200,{
success:true
});

}
if(
req.method==="POST"&&
path==="/api/admin/login"
){

const b=await body(req);

const result=
await adminLogin(
b.email,
b.password
);

return send(
res,
result.success?200:401,
result
);

}

if(
req.method==="POST"&&
path==="/api/admin/logout"
){

const authorization=
req.headers.authorization||"";

if(
authorization.startsWith(
"Bearer "
)
){

await db(
`DELETE FROM admin_sessions
WHERE token=$1`,
[
authorization.slice(7).trim()
]
);

}

return send(res,200,{
success:true,
message:
"Admin logged out."
});

}

if(
req.method==="GET"&&
path==="/api/admin/me"
){

const admin=
await adminFromToken(req);

if(!admin){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

return send(res,200,{
success:true,
admin
});

}

if(
req.method==="GET"&&
path==="/api/admin/users"
){

const admin=
await adminFromToken(req);

if(!admin){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const result=await db(
`SELECT
id,
user_id,
name,
phone,
email,
created_at,
updated_at
FROM users
ORDER BY created_at DESC
LIMIT 500`
);

return send(res,200,{
success:true,
users:result.rows
});

}

if(
req.method==="GET"&&
path==="/api/admin/transactions"
){

const admin=
await adminFromToken(req);

if(!admin){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const result=await db(
`SELECT *
FROM transactions
ORDER BY date DESC
LIMIT 500`
);

return send(res,200,{
success:true,
transactions:
result.rows.map(item=>({
...item,
amount:Number(item.amount)
}))
});

}

if(
req.method==="POST"&&
path==="/api/services/vtu"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const b=await body(req);

const result=
await processVTUService({
userId:user.user_id,
amount:Number(b.amount),
service:
clean(b.service||"VTU"),
providerPayload:
b.providerPayload||b
});

return send(
res,
result.statusCode||
(result.success?200:400),
result
);

}

if(
req.method==="POST"&&
path==="/api/admin/reset-password"
){

const admin=
await adminFromToken(req);

if(!admin){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

if(
!ADMIN_EMAIL||
!ADMIN_PASSWORD
){

return send(res,500,{
success:false,
message:
"ADMIN_EMAIL or ADMIN_PASSWORD is missing."
});

}

const passwordHash=
hashPassword(
ADMIN_PASSWORD
);

await db(
`UPDATE admins
SET
password_hash=$1
WHERE LOWER(email)=LOWER($2)`,
[
passwordHash,
ADMIN_EMAIL
]
);

return send(res,200,{
success:true,
message:
"Admin password reset successfully."
});

}

return send(res,404,{
success:false,
message:
"API route not found"
});

}catch(error){

console.error(
"SERVER ERROR:",
error
);

return send(res,500,{
success:false,
message:
"Internal server error"
});

}

});

setup().then(()=>{

server.listen(
PORT,
"0.0.0.0",
()=>{

console.log(
`BOLTIV API running on port ${PORT}`
);

}

);

}).catch(error=>{

console.error(
"STARTUP ERROR:",
error
);

process.exit(1);

});
