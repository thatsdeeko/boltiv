const http=require("node:http");
const crypto=require("node:crypto");
const {Pool}=require("pg");

const PORT=process.env.PORT||3000;

const DATABASE_URL=process.env.DATABASE_URL||"";
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"";
const FRONTEND_URL=
process.env.FRONTEND_URL||
"https://thatsdeeko.github.io/boltiv";

const ADMIN_EMAIL=process.env.ADMIN_EMAIL||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

const VTU_API_URL=process.env.VTU_API_URL||"";
const VTU_API_KEY=process.env.VTU_API_KEY||"";

const SESSION_DAYS=30;

const pool=new Pool({
connectionString:DATABASE_URL,
ssl:DATABASE_URL
?{rejectUnauthorized:false}
:false
});

function send(res,status,data){
res.writeHead(status,{
"Content-Type":"application/json; charset=utf-8",
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

function token(){
return crypto.randomBytes(32).toString("hex");
}

function reference(prefix="BOLTIV"){
return `${prefix}-${Date.now()}-${crypto
.randomBytes(5)
.toString("hex")}`;
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

function hashPassword(
password,
salt=crypto.randomBytes(16).toString("hex")
){
return `${salt}:${crypto
.scryptSync(password,salt,64)
.toString("hex")}`;
}

function verifyPassword(password,stored){
try{

if(!stored||!stored.includes(":")){
return false;
}

const parts=stored.split(":");

const salt=parts[0];
const key=parts[1];

if(!salt||!key){
return false;
}

const hash=crypto.scryptSync(
password,
salt,
64
);

return crypto.timingSafeEqual(
hash,
Buffer.from(key,"hex")
);

}catch(error){

console.error(
"PASSWORD VERIFY ERROR:",
error.message
);

return false;
}
}

/* =========================
   DATABASE SETUP
========================= */

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
user_id TEXT UNIQUE NOT NULL,
name TEXT NOT NULL,
phone TEXT NOT NULL,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
initials TEXT,
created_at TIMESTAMPTZ NOT NULL
DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL
DEFAULT NOW()
)
`);

await db(`
CREATE TABLE IF NOT EXISTS user_sessions(
token TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL
DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)
`);

await db(`
CREATE INDEX IF NOT EXISTS
idx_user_sessions_user_id
ON user_sessions(user_id)
`);

await db(`
CREATE INDEX IF NOT EXISTS
idx_user_sessions_expires
ON user_sessions(expires_at)
`);

await db(`
CREATE TABLE IF NOT EXISTS wallets(
user_id TEXT PRIMARY KEY,
balance NUMERIC(14,2)
NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL
DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL
DEFAULT NOW()
)
`);

await db(`
CREATE TABLE IF NOT EXISTS transactions(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
type TEXT NOT NULL,
service TEXT NOT NULL,
amount NUMERIC(14,2)
NOT NULL,
reference TEXT UNIQUE,
status TEXT NOT NULL,
date TIMESTAMPTZ NOT NULL
DEFAULT NOW()
)
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
provider_reference TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
phone TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
network TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
plan TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
meter_number TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
meter_type TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
smartcard_number TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
cable_package TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
provider TEXT
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
response_data JSONB
`);

await db(`
ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS
created_at TIMESTAMPTZ
`);

await db(`
UPDATE transactions
SET created_at=date
WHERE created_at IS NULL
`);

await db(`
CREATE TABLE IF NOT EXISTS payments(
reference TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
email TEXT NOT NULL,
amount NUMERIC(14,2)
NOT NULL,
amount_kobo BIGINT NOT NULL,
status TEXT NOT NULL,
credited BOOLEAN NOT NULL
DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL
DEFAULT NOW(),
credited_at TIMESTAMPTZ
)
`);

await db(`
CREATE TABLE IF NOT EXISTS admins(
id BIGSERIAL PRIMARY KEY,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL
DEFAULT NOW()
)
`);

await db(`
CREATE TABLE IF NOT EXISTS admin_sessions(
token TEXT PRIMARY KEY,
admin_id BIGINT NOT NULL
REFERENCES admins(id)
ON DELETE CASCADE,
created_at TIMESTAMPTZ NOT NULL
DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)
`);

await syncAdmin();

console.log(
"PostgreSQL database ready."
);
}

/* =========================
   USER HELPERS
========================= */

function createUserId(){
return `BOLTIV-${crypto.randomUUID()}`;
}

function getInitials(name){
const parts=clean(name)
.split(/\s+/)
.filter(Boolean);

if(!parts.length){
return "U";
}

if(parts.length===1){
return parts[0]
.charAt(0)
.toUpperCase();
}

return (
parts[0].charAt(0)+
parts[parts.length-1].charAt(0)
).toUpperCase();
}

async function createWallet(userId){

await db(`
INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING
`,[
userId
]);

}

async function getWallet(userId){

const result=await db(`
SELECT user_id,balance
FROM wallets
WHERE user_id=$1
`,[
userId
]);

if(!result.rows.length){
return null;
}

return{
userId:result.rows[0].user_id,
balance:Number(
result.rows[0].balance
)
};
}

async function getUserById(userId){

const result=await db(`
SELECT
id,
user_id,
name,
phone,
email,
initials,
created_at,
updated_at
FROM users
WHERE user_id=$1
`,[
userId
]);

return result.rows[0]||null;
}

async function getUserByEmail(email){

const result=await db(`
SELECT *
FROM users
WHERE LOWER(email)=LOWER($1)
`,[
email
]);

return result.rows[0]||null;
}

/* =========================
   USER SESSION
========================= */

async function createUserSession(userId){

const sessionToken=token();

await db(`
DELETE FROM user_sessions
WHERE user_id=$1
OR expires_at<NOW()
`,[
userId
]);

await db(`
INSERT INTO user_sessions(
token,
user_id,
expires_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '${SESSION_DAYS} days'
)
`,[
sessionToken,
userId
]);

return sessionToken;
}

async function getUserFromRequest(req){

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

const result=await db(`
SELECT
u.id,
u.user_id,
u.name,
u.phone,
u.email,
u.initials,
u.created_at,
u.updated_at
FROM user_sessions s
JOIN users u
ON u.user_id=s.user_id
WHERE s.token=$1
AND s.expires_at>NOW()
`,[
sessionToken
]);

return result.rows[0]||null;
}

async function requireUser(req,res){

const user=await getUserFromRequest(req);

if(!user){

send(res,401,{
success:false,
message:"Authentication required.",
code:"AUTH_REQUIRED"
});

return null;
}

return user;
}

/* =========================
   USER REGISTRATION
========================= */

async function registerUser({
name,
phone,
email,
password
}){

name=clean(name);
phone=clean(phone);
email=clean(email).toLowerCase();
password=String(password||"");

if(name.length<2){
return{
success:false,
message:"Please enter your full name."
};
}

if(!validPhone(phone)){
return{
success:false,
message:
"Enter a valid Nigerian phone number."
};
}

if(!validEmail(email)){
return{
success:false,
message:
"Enter a valid email address."
};
}

if(password.length<6){
return{
success:false,
message:
"Password must contain at least 6 characters."
};
}

const existing=
await getUserByEmail(email);

if(existing){
return{
success:false,
message:
"An account with this email already exists."
};
}

const userId=createUserId();

const passwordHash=
hashPassword(password);

const initials=
getInitials(name);

const result=await db(`
INSERT INTO users(
user_id,
name,
phone,
email,
password_hash,
initials
)
VALUES(
$1,$2,$3,$4,$5,$6
)
RETURNING
user_id,
name,
phone,
email,
initials,
created_at
`,[
userId,
name,
phone,
email,
passwordHash,
initials
]);

const user=result.rows[0];

await createWallet(user.user_id);

const session=
await createUserSession(
user.user_id
);

return{
success:true,
message:
"Account created successfully.",
token:session,
user:{
userId:user.user_id,
name:user.name,
phone:user.phone,
email:user.email,
initials:user.initials,
createdAt:user.created_at
}
};
}

/* =========================
   USER LOGIN
========================= */

async function loginUser(
email,
password
){

email=clean(email).toLowerCase();
password=String(password||"");

if(!validEmail(email)){
return{
success:false,
message:
"Enter a valid email address."
};
}

if(!password){
return{
success:false,
message:
"Enter your password."
};
}

const user=
await getUserByEmail(email);

if(!user){
return{
success:false,
message:
"Invalid email or password."
};
}

const valid=
verifyPassword(
password,
user.password_hash
);

if(!valid){
return{
success:false,
message:
"Invalid email or password."
};
}

await createWallet(
user.user_id
);

const session=
await createUserSession(
user.user_id
);

return{
success:true,
message:"Login successful.",
token:session,
user:{
userId:user.user_id,
name:user.name,
phone:user.phone,
email:user.email,
initials:user.initials,
createdAt:user.created_at
}
};
}

/* =========================
   USER LOGOUT
========================= */

async function logoutUser(req){

const authorization=
req.headers.authorization||"";

if(!authorization.startsWith(
"Bearer "
)){
return;
}

const sessionToken=
authorization.slice(7).trim();

if(!sessionToken){
return;
}

await db(`
DELETE FROM user_sessions
WHERE token=$1
`,[
sessionToken
]);
}

/* =========================
   USER TRANSACTIONS
========================= */

async function transactions(userId){

const result=await db(`
SELECT
id,
type,
service,
amount,
reference,
provider_reference,
status,
phone,
network,
plan,
meter_number,
meter_type,
smartcard_number,
cable_package,
provider,
response_data,
date,
created_at
FROM transactions
WHERE user_id=$1
ORDER BY date DESC
`,[
userId
]);

return result.rows.map(row=>({
...row,
amount:Number(row.amount)
}));
}

/* =========================
   ADMIN PASSWORD SYNC
========================= */

async function syncAdmin(){

if(!ADMIN_EMAIL||
!ADMIN_PASSWORD){

console.log(
"ADMIN_EMAIL or ADMIN_PASSWORD is missing."
);

return;
}

const result=await db(`
SELECT id,email,password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)
`,[
ADMIN_EMAIL
]);

if(!result.rows.length){

await db(`
INSERT INTO admins(
email,
password_hash
)
VALUES($1,$2)
`,[
ADMIN_EMAIL,
hashPassword(
ADMIN_PASSWORD
)
]);

console.log(
"Admin account created."
);

}else{

await db(`
UPDATE admins
SET
email=$1,
password_hash=$2
WHERE id=$3
`,[
ADMIN_EMAIL,
hashPassword(
ADMIN_PASSWORD
),
result.rows[0].id
]);

console.log(
"Admin account synchronized."
);
}
}

/* =========================
   ADMIN AUTH
========================= */

async function admin(req){

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

const result=await db(`
SELECT
a.id,
a.email
FROM admin_sessions s
JOIN admins a
ON a.id=s.admin_id
WHERE s.token=$1
AND s.expires_at>NOW()
`,[
sessionToken
]);

return result.rows[0]||null;
}

async function adminLogin(
email,
password
){

email=clean(email).toLowerCase();
password=String(password||"");

console.log(
"=== ADMIN LOGIN TRACE ==="
);

console.log(
"Login email received:",
email
);

console.log(
"Configured ADMIN_EMAIL:",
ADMIN_EMAIL
);

if(!ADMIN_EMAIL||
!ADMIN_PASSWORD){

return{
success:false,
message:
"Admin environment variables are not configured."
};
}

const result=await db(`
SELECT
id,
email,
password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)
`,[
ADMIN_EMAIL
]);

if(!result.rows.length){

return{
success:false,
message:
"Admin account not found."
};
}

const adminAccount=
result.rows[0];

const passwordValid=
verifyPassword(
password,
adminAccount.password_hash
);

if(
email!==ADMIN_EMAIL.toLowerCase()||
!passwordValid
){

console.log(
"ADMIN LOGIN FAILED"
);

return{
success:false,
message:
"Invalid admin credentials."
};
}

const sessionToken=token();

await db(`
DELETE FROM admin_sessions
WHERE expires_at<NOW()
`);

await db(`
INSERT INTO admin_sessions(
token,
admin_id,
expires_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '24 hours'
)
`,[
sessionToken,
adminAccount.id
]);

console.log(
"ADMIN LOGIN SUCCESS"
);

return{
success:true,
message:
"Admin login successful.",
token:sessionToken,
admin:{
id:adminAccount.id,
email:adminAccount.email
}
};
}

/* =========================
   PART 1 COMPLETE
========================= */
/* =========================
   PAYSTACK
========================= */

async function paystack(path,options={}){
if(!PAYSTACK_SECRET_KEY){
return{
status:500,
data:{
status:false,
message:
"Paystack is not configured on the server."
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
"Content-Type":
"application/json",
...(options.headers||{})
}
}
);

let data;

try{
data=await response.json();
}catch(error){
data={
status:false,
message:
"Invalid response from Paystack."
};
}

return{
status:response.status,
data
};
}

/* =========================
   INITIALIZE PAYMENT
========================= */

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

const response=
await paystack(
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
service:
"BOLTIV Wallet Funding"
}
})
}
);

if(!response.data.status){

return{
success:false,
message:
response.data.message||
"Unable to initialize payment."
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
VALUES(
$1,$2,$3,$4,$5,$6,$7
)
`,[
ref,
userId,
email,
amount,
Math.round(amount*100),
"initialized",
false
]);

return{
success:true,
message:
"Payment initialized.",
reference:ref,
authorizationUrl:
response.data.data
.authorization_url,
accessCode:
response.data.data
.access_code
};
}

/* =========================
   VERIFY PAYMENT
========================= */

async function verifyPayment(ref){

if(!PAYSTACK_SECRET_KEY){
return{
success:false,
message:
"Paystack is not configured on the server."
};
}

const paymentResult=
await db(`
SELECT *
FROM payments
WHERE reference=$1
`,[
ref
]);

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
reference:ref,
balance:
currentWallet?
currentWallet.balance:
0
};
}

const response=
await paystack(
`/transaction/verify/${encodeURIComponent(ref)}`,
{
method:"GET"
}
);

if(!response.data.status){

return{
success:false,
message:
response.data.message||
"Unable to verify payment."
};
}

const transaction=
response.data.data;

if(transaction.status!=="success"){

await db(`
UPDATE payments
SET status=$1
WHERE reference=$2
`,[
transaction.status,
ref
]);

return{
success:false,
message:
`Payment status: ${transaction.status}`,
status:
transaction.status
};
}

if(transaction.currency!=="NGN"){

return{
success:false,
message:
"Invalid payment currency."
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

await client.query(
"BEGIN"
);

await client.query(`
INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING
`,[
payment.user_id
]);

const walletResult=
await client.query(`
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
VALUES(
$1,$2,$3,$4,$5,$6
)
ON CONFLICT(reference)
DO NOTHING
`,[
payment.user_id,
"credit",
"Wallet Funding",
Number(payment.amount),
ref,
"successful"
]);

await client.query(`
UPDATE payments
SET
status='success',
credited=TRUE,
credited_at=NOW()
WHERE reference=$1
`,[
ref
]);

await client.query(
"COMMIT"
);

return{
success:true,
message:
"Wallet funded successfully.",
reference:ref,
amount:
Number(payment.amount),
balance:
Number(
walletResult.rows[0].balance
)
};

}catch(error){

await client.query(
"ROLLBACK"
);

throw error;

}finally{

client.release();

}
}

/* =========================
   WALLET DEBIT
========================= */

async function debitWallet(
userId,
amount
){

const client=
await pool.connect();

try{

await client.query(
"BEGIN"
);

await client.query(`
INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING
`,[
userId
]);

const result=
await client.query(`
UPDATE wallets
SET
balance=balance-$1,
updated_at=NOW()
WHERE user_id=$2
AND balance >= $1
RETURNING balance
`,[
amount,
userId
]);

if(!result.rows.length){

await client.query(
"ROLLBACK"
);

return{
success:false,
message:
"Insufficient wallet balance."
};
}

await client.query(
"COMMIT"
);

return{
success:true,
balance:
Number(
result.rows[0].balance
)
};

}catch(error){

await client.query(
"ROLLBACK"
);

throw error;

}finally{

client.release();

}
}

/* =========================
   WALLET REFUND
========================= */

async function refundWallet(
userId,
amount
){

await db(`
UPDATE wallets
SET
balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2
`,[
amount,
userId
]);

}

/* =========================
   TRANSACTION INSERT
========================= */

async function insertTransaction(
client,
data
){

const result=
await client.query(`
INSERT INTO transactions(
user_id,
type,
service,
amount,
reference,
provider_reference,
status,
phone,
network,
plan,
meter_number,
meter_type,
smartcard_number,
cable_package,
provider,
response_data
)
VALUES(
$1,$2,$3,$4,$5,$6,$7,$8,
$9,$10,$11,$12,$13,$14,$15,$16
)
RETURNING id
`,[
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
data.responseData?
JSON.stringify(
data.responseData
):
null
]);

return result.rows[0];

}

/* =========================
   VTU PROVIDER
========================= */

async function callVTUProvider(
payload
){

if(
!VTU_API_URL||
!VTU_API_KEY
){

return{
success:false,
configured:false,
message:
"VTU provider is not configured on the server."
};
}

const response=
await fetch(
VTU_API_URL,
{
method:"POST",
headers:{
"Content-Type":
"application/json",
Authorization:
`Bearer ${VTU_API_KEY}`
},
body:
JSON.stringify(payload)
}
);

let data;

try{

data=await response.json();

}catch(error){

try{
data={
raw:
await response.text()
};
}catch{
data={
message:
"Unable to read VTU response."
};
}

}

return{
success:
response.ok,
configured:true,
httpStatus:
response.status,
data
};

}

/* =========================
   VTU SERVICE PROCESSOR
========================= */

async function processVTUService({
userId,
service,
amount,
provider,
providerPayload,
phone,
network,
plan,
meterNumber,
meterType,
smartcardNumber,
cablePackage
}){

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

await createWallet(
userId
);

const currentWallet=
await getWallet(
userId
);

if(
!currentWallet||
currentWallet.balance<amount
){

return{
success:false,
statusCode:400,
message:
"Insufficient wallet balance.",
balance:
currentWallet?
currentWallet.balance:
0
};
}

const ref=
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
message:
"VTU provider connection failed."
};
}

/*
If provider is not configured,
refund the user's wallet.
*/
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

/*
Provider rejected transaction.
*/
if(!providerResult.success){

await refundWallet(
userId,
amount
);

const client=
await pool.connect();

try{

await insertTransaction(
client,
{
userId,
type:"debit",
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
responseData:
providerResult.data
}
);

}finally{

client.release();

}

const refundedWallet=
await getWallet(
userId
);

return{
success:false,
statusCode:400,
message:
"VTU transaction failed.",
reference:ref,
balance:
refundedWallet?
refundedWallet.balance:
0
};
}

const providerData=
providerResult.data;

const providerReference=
providerData?.reference||
providerData?.transaction_id||
providerData?.transactionId||
providerData?.data?.reference||
providerData?.data?.transaction_id||
null;

const client=
await pool.connect();

try{

await insertTransaction(
client,
{
userId,
type:"debit",
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
responseData:
providerData
}
);

}finally{

client.release();

}

const finalWallet=
await getWallet(
userId
);

return{
success:true,
message:
`${service} purchase successful.`,
reference:ref,
providerReference,
service,
amount,
status:"successful",
balance:
finalWallet?
finalWallet.balance:
0,
data:
providerData
};

}

/* =========================
   USER WALLET RESPONSE
========================= */

async function walletResponse(
userId
){

await createWallet(
userId
);

const currentWallet=
await getWallet(
userId
);

return{
success:true,
userId,
balance:
currentWallet?
currentWallet.balance:
0,
transactions:
await transactions(
userId
)
};

}

/* =========================
   PART 2 COMPLETE
========================= */
