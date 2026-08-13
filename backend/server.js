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
