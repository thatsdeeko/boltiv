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
