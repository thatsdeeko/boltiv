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

const RESEND_API_KEY=process.env.RESEND_API_KEY||"";
// Use a Resend-safe sender for testing when MAIL_FROM is not configured.
// For production, set MAIL_FROM to an address on a domain verified in Resend.
const MAIL_FROM=(process.env.MAIL_FROM||"BOLTIV <onboarding@resend.dev>").trim();
const FRONTEND_ORIGINS=String(process.env.FRONTEND_ORIGIN||(()=>{try{return new URL(FRONTEND_URL).origin}catch{return FRONTEND_URL}})())
.split(",")
.map(v=>v.trim())
.filter(Boolean);
const DEFAULT_FRONTEND_ORIGIN=FRONTEND_ORIGINS[0]||"";
function corsOrigin(req){
const origin=String(req.headers.origin||"");
if(origin&&FRONTEND_ORIGINS.includes(origin))return origin;
return DEFAULT_FRONTEND_ORIGIN;
}

const pool=new Pool({
connectionString:DATABASE_URL,
ssl:DATABASE_URL?{rejectUnauthorized:false}:false
});

// Lightweight in-process abuse protection. For multi-instance deployments,
// replace this with a shared store such as Redis.
const rateBuckets=new Map();
function requestIp(req){
return String(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"unknown").split(",")[0].trim();
}
function rateLimit(req,key,limit,windowMs){
const now=Date.now();
const bucketKey=`${key}:${requestIp(req)}`;
let b=rateBuckets.get(bucketKey);
if(!b||b.resetAt<=now)b={count:0,resetAt:now+windowMs};
b.count++;
rateBuckets.set(bucketKey,b);
if(b.count>limit)return {allowed:false,retryAfter:Math.ceil((b.resetAt-now)/1000)};
return {allowed:true};
}
function rateLimitedResponse(res,rl){
res.setHeader("Retry-After",String(rl.retryAfter));
return send(res,429,{success:false,message:"Too many requests. Please try again later."});
}
setInterval(()=>{const now=Date.now();for(const [k,v] of rateBuckets){if(v.resetAt<=now)rateBuckets.delete(k);}},10*60*1000).unref();

function send(res,status,data){
res.writeHead(status,{
"Content-Type":"application/json",
"Access-Control-Allow-Origin":res.__corsOrigin||DEFAULT_FRONTEND_ORIGIN,
"Vary":"Origin",
"Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS",
"Access-Control-Allow-Headers":"Content-Type,Authorization,X-Idempotency-Key",
"X-Content-Type-Options":"nosniff",
"X-Frame-Options":"DENY",
"Referrer-Policy":"strict-origin-when-cross-origin",
"Cache-Control":"no-store"
});
res.end(JSON.stringify(data));
return true;
}

async function body(req){
return new Promise((resolve,reject)=>{
let data="";

req.on("data",chunk=>{
data+=chunk;
if(data.length>1024*1024){req.destroy();reject(new Error("Request body too large."));}
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

function verifyPassword(
password,
stored
){

try{

const parts=
String(stored||"").split(":");

if(parts.length!==2){
return false;
}

const hash=
crypto.scryptSync(
password,
parts[0],
64
);

const saved=
Buffer.from(
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
await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
await db(`CREATE INDEX IF NOT EXISTS users_status_idx ON users(status)`);

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
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_reference TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS metadata JSONB`);
await db(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_idx ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
await db(`CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions(status)`);
await db(`CREATE INDEX IF NOT EXISTS transactions_provider_reference_idx ON transactions(provider_reference) WHERE provider_reference IS NOT NULL`);

await db(`
CREATE TABLE IF NOT EXISTS user_security(
user_id TEXT PRIMARY KEY,
transaction_pin_hash TEXT,
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS support_tickets(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
subject TEXT NOT NULL,
message TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'open',
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS notifications(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
title TEXT NOT NULL,
message TEXT NOT NULL,
type TEXT NOT NULL DEFAULT 'info',
read BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
await db(`CREATE TABLE IF NOT EXISTS admin_wallets(admin_id BIGINT PRIMARY KEY,balance NUMERIC(14,2) NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS admin_wallet_ledger(id BIGSERIAL PRIMARY KEY,admin_id BIGINT NOT NULL,type TEXT NOT NULL,amount NUMERIC(14,2) NOT NULL,balance_after NUMERIC(14,2) NOT NULL,reference TEXT UNIQUE NOT NULL,description TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS admin_wallet_ledger_admin_idx ON admin_wallet_ledger(admin_id,created_at DESC)`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS recipient_type TEXT NOT NULL DEFAULT 'user'`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_id BIGINT`);
await db(`CREATE TABLE IF NOT EXISTS admin_audit_logs(
id BIGSERIAL PRIMARY KEY,
admin_id BIGINT,
action TEXT NOT NULL,
target_type TEXT,
target_id TEXT,
details JSONB,
ip TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_logs(created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS support_messages(
id BIGSERIAL PRIMARY KEY,
ticket_id BIGINT NOT NULL,
sender_type TEXT NOT NULL,
sender_id TEXT,
message TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages(ticket_id,created_at)`);

await db(`CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS services(key TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT,enabled BOOLEAN NOT NULL DEFAULT TRUE,fee NUMERIC(14,2) NOT NULL DEFAULT 0,maintenance BOOLEAN NOT NULL DEFAULT FALSE,config JSONB NOT NULL DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS security_events(id BIGSERIAL PRIMARY KEY,admin_id BIGINT,event_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'info',details JSONB,ip TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events(created_at DESC)`);
for(const [key,name,icon] of [['airtime','Airtime','📱'],['data','Data','🌐'],['electricity','Electricity','💡'],['cable','Cable TV','📺'],['education','Education','🎫']]) await db(`INSERT INTO services(key,name,icon) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`,[key,name,icon]);
for(const [key,value] of [['maintenance_mode',false],['registration_enabled',true]]) await db(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING`,[key,JSON.stringify(value)]);

await db(`
CREATE TABLE IF NOT EXISTS password_reset_tokens(
id BIGSERIAL PRIMARY KEY,
user_id BIGINT NOT NULL,
token_hash TEXT UNIQUE NOT NULL,
expires_at TIMESTAMPTZ NOT NULL,
used BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

await db(
`CREATE INDEX IF NOT EXISTS
password_reset_tokens_user_idx
ON password_reset_tokens(user_id)`
);

await db(
`CREATE INDEX IF NOT EXISTS
password_reset_tokens_expiry_idx
ON password_reset_tokens(expires_at)`
);

console.log(
"DATABASE SETUP COMPLETE"
);

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

const result=
await db(
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

const result=
await db(
`SELECT id,user_id,type,service,amount,reference,status,date,idempotency_key,provider_reference,recipient,metadata
FROM transactions
WHERE user_id=$1
ORDER BY date DESC
LIMIT 100`,
[userId]
);

return result.rows.map(item=>({
...item,
amount:Number(
item.amount
)
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

const result=
await db(
`SELECT
u.id,
u.user_id,
u.name,
u.phone,
u.email,
u.status
FROM user_sessions s
JOIN users u
ON u.id=s.user_id
WHERE s.token=$1
AND s.expires_at>NOW()
AND u.status='active' `,
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

email=
clean(email).toLowerCase();

password=
String(password||"");

name=
clean(name);

phone=
clean(phone);

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

const existing=
await db(
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

const userId=
makeUserId();

const passwordHash=
hashPassword(password);

const result=
await db(
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

const user=
result.rows[0];

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

email=
clean(email).toLowerCase();

password=
String(password||"");

const result=
await db(
`SELECT
id,
user_id,
name,
phone,
email,
password_hash,
status
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

const user=
result.rows[0];

if(user.status==="suspended"){
return{success:false,message:"Your account is suspended. Please contact support."};
}

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

const sessionToken=
token();

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
"Login successful.",
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
async function sendEmail({
to,
subject,
html
}){

if(!RESEND_API_KEY){

console.log(
"RESEND_API_KEY is not configured."
);

return{
success:false,
message:
"Email service is not configured."
};

}

try{

const response=
await fetch(
"https://api.resend.com/emails",
{
method:"POST",
headers:{
"Authorization":
`Bearer ${RESEND_API_KEY}`,
"Content-Type":
"application/json"
},
body:JSON.stringify({
from:MAIL_FROM,
to:[to],
subject,
html
})
}
);

const data=
await response.json();

if(!response.ok){

console.error(
"EMAIL ERROR:",
data
);

return{
success:false,
message:
"Unable to send email."
};

}

return{
success:true,
data
};

}catch(error){

console.error(
"EMAIL CONNECTION ERROR:",
error
);

return{
success:false,
message:
"Unable to send email."
};

}

}


function hashResetToken(value){

return crypto
.createHash("sha256")
.update(String(value))
.digest("hex");

}


async function requestPasswordReset(
email
){

email=
clean(email).toLowerCase();

if(!validEmail(email)){

return{
success:true,
message:
"If an account exists for that email, a password reset link has been sent."
};

}

/*
Always return the same public response
whether the account exists or not.
This prevents email/account enumeration.
*/

const genericMessage=
"If an account exists for that email, a password reset link has been sent.";

const result=
await db(
`SELECT
id,
name,
email
FROM users
WHERE LOWER(email)=LOWER($1)
LIMIT 1`,
[email]
);

if(!result.rows.length){

return{
success:true,
message:
genericMessage
};

}

const user=
result.rows[0];

/*
Invalidate previous unused reset tokens
for this user.
*/

await db(
`UPDATE password_reset_tokens
SET used=TRUE
WHERE user_id=$1
AND used=FALSE`,
[user.id]
);

const rawToken=
crypto.randomBytes(32).toString("hex");

const tokenHash=
hashResetToken(rawToken);

await db(
`INSERT INTO password_reset_tokens(
user_id,
token_hash,
expires_at,
used,
created_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '30 minutes',
FALSE,
NOW()
)`,
[
user.id,
tokenHash
]
);

const resetUrl=
`${FRONTEND_URL}/reset-password.html?token=${encodeURIComponent(rawToken)}`;

const displayName=
clean(user.name)||
"BOLTIV User";

const emailResult=
await sendEmail({

to:user.email,

subject:
"BOLTIV Password Reset",

html:`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
</head>

<body style="
margin:0;
padding:0;
background:#f6f6f6;
font-family:Arial,sans-serif;
color:#171717;
">

<div style="
max-width:520px;
margin:40px auto;
background:#ffffff;
border-radius:18px;
padding:32px;
border:1px solid #e7e7e7;
">

<div style="
font-size:28px;
font-weight:900;
letter-spacing:4px;
color:#c49a25;
text-align:center;
">
BOLTIV
</div>

<h2 style="
text-align:center;
margin-top:28px;
">
Reset your password
</h2>

<p style="
font-size:15px;
line-height:1.7;
color:#555;
">
Hello ${escapeHtmlEmail(displayName)},
</p>

<p style="
font-size:15px;
line-height:1.7;
color:#555;
">
We received a request to reset your BOLTIV password.
Click the button below to choose a new password.
</p>

<div style="
text-align:center;
margin:30px 0;
">

<a
href="${resetUrl}"
style="
display:inline-block;
padding:14px 24px;
background:#d4af37;
color:#111111;
text-decoration:none;
font-weight:900;
border-radius:10px;
"
>
RESET PASSWORD
</a>

</div>

<p style="
font-size:13px;
line-height:1.6;
color:#777;
">
This link expires in 30 minutes and can only be used once.
</p>

<p style="
font-size:13px;
line-height:1.6;
color:#777;
">
If you didn't request this password reset, you can safely ignore this email.
</p>

</div>

</body>
</html>
`

});

if(!emailResult.success){

/*
The reset token must never remain usable when the
email could not be sent. Remove the token we just
created so the user cannot end up with an unusable
reset request.
*/

console.error(
"PASSWORD RESET EMAIL FAILED:",
emailResult.message
);

try{

await db(
`DELETE FROM password_reset_tokens
 WHERE user_id=$1
 AND token_hash=$2`,
[user.id,tokenHash]
);

}catch(cleanupError){

console.error(
"PASSWORD RESET TOKEN CLEANUP FAILED:",
cleanupError
);

}

return{
success:false,
message:
"We couldn't send the password reset email right now. Please try again later."
};

}

return{
success:true,
message:
genericMessage
};

}


function escapeHtmlEmail(value){

return String(value??"")
.replace(/&/g,"&amp;")
.replace(/</g,"&lt;")
.replace(/>/g,"&gt;")
.replace(/"/g,"&quot;")
.replace(/'/g,"&#039;");

}


async function resetPassword(
rawToken,
newPassword
){

rawToken=
clean(rawToken);

newPassword=
String(newPassword||"");

if(!rawToken){

return{
success:false,
message:
"Password reset token is required."
};

}

if(newPassword.length<6){

return{
success:false,
message:
"Password must contain at least 6 characters."
};

}

const tokenHash=
hashResetToken(rawToken);

const result=
await db(
`SELECT
id,
user_id,
expires_at,
used
FROM password_reset_tokens
WHERE token_hash=$1
AND used=FALSE
AND expires_at>NOW()
LIMIT 1`,
[tokenHash]
);

if(!result.rows.length){

return{
success:false,
message:
"This password reset link is invalid or has expired."
};

}

const reset=
result.rows[0];

const passwordHash=
hashPassword(newPassword);

const client=
await pool.connect();

try{

await client.query("BEGIN");

/*
Update the password.
*/

await client.query(
`UPDATE users
SET password_hash=$1,
updated_at=NOW()
WHERE id=$2`,
[
passwordHash,
reset.user_id
]
);

/*
Mark the token as used.
*/

await client.query(
`UPDATE password_reset_tokens
SET used=TRUE
WHERE id=$1`,
[
reset.id
]
);

/*
Invalidate all existing sessions.
This forces the user to log in again
with the new password.
*/

await client.query(
`DELETE FROM user_sessions
WHERE user_id=$1`,
[
reset.user_id
]
);

await client.query("COMMIT");

return{
success:true,
message:
"Password reset successful. Please log in with your new password."
};

}catch(error){

await client.query("ROLLBACK");

console.error(
"PASSWORD RESET ERROR:",
error
);

return{
success:false,
message:
"Unable to reset password."
};

}finally{

client.release();

}

}


async function cleanupPasswordResetTokens(){

if(!DATABASE_URL){
return;
}

try{

await db(
`DELETE FROM password_reset_tokens
WHERE expires_at<NOW()
OR used=TRUE`
);

}catch(error){

console.error(
"RESET TOKEN CLEANUP ERROR:",
error.message
);

}

}


async function adminLogin(
email,
password,
req=null
){

if(req){const rl=rateLimit(req,"admin-login",5,15*60*1000);if(!rl.allowed)return{success:false,statusCode:429,message:"Too many admin login attempts. Try again later."};}

email=
clean(email).toLowerCase();

password=
String(password||"");

if(!ADMIN_EMAIL||
!ADMIN_PASSWORD){

return{
success:false,
message:
"Admin environment variables are not configured."
};

}

let result=
await db(
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

result=
await db(
`INSERT INTO admins(
email,
password_hash
)
VALUES($1,$2)
RETURNING
id,
email,
password_hash`,
[
ADMIN_EMAIL,
passwordHash
]
);

}else{

/*
Keep the database admin synchronized
with Render environment variables.
*/

const admin=
result.rows[0];

if(
admin.email.toLowerCase()!==
ADMIN_EMAIL.toLowerCase()||
!verifyPassword(
ADMIN_PASSWORD,
admin.password_hash
)
){

const passwordHash=
hashPassword(ADMIN_PASSWORD);

result=
await db(
`UPDATE admins
SET
email=$1,
password_hash=$2
WHERE id=$3
RETURNING
id,
email,
password_hash`,
[
ADMIN_EMAIL,
passwordHash,
admin.id
]
);

}

}

const admin=
result.rows[0];

if(!admin){

return{
success:false,
message:
"Unable to initialize admin account."
};

}

if(
email!==ADMIN_EMAIL.toLowerCase()
||
!verifyPassword(
password,
admin.password_hash
)
){

await recordSecurityEvent('admin_login_failed','warning',{email},req,null);

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

const sessionToken=
token();

await recordSecurityEvent('admin_login_success','info',{email:admin.email},req,admin.id);

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
token:
sessionToken,
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

if(!sessionToken){
return null;
}

const result=
await db(
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


async function logoutAdmin(req){

const authorization=
req.headers.authorization||"";

if(
authorization.startsWith(
"Bearer "
)
){

const sessionToken=
authorization.slice(7).trim();

if(sessionToken){

await db(
`DELETE FROM admin_sessions
WHERE token=$1`,
[
sessionToken
]
);

}

}

return{
success:true,
message:
"Admin logged out successfully."
};

  }
async function createPayment(
userId,
email,
amount
){

if(!PAYSTACK_SECRET_KEY){

return{
success:false,
message:
"Paystack is not configured."
};

}

const amountKobo=
Math.round(
Number(amount)*100
);

if(!Number.isFinite(amountKobo)||
amountKobo<=0){

return{
success:false,
message:
"Invalid payment amount."
};

}

const referenceValue=
reference("BOLTIV-PAY");

await db(
`INSERT INTO payments(
reference,
user_id,
email,
amount,
amount_kobo,
status,
credited,
created_at
)
VALUES(
$1,$2,$3,$4,$5,
'pending',
FALSE,
NOW()
)`,
[
referenceValue,
userId,
email,
Number(amount),
amountKobo
]
);

try{

const response=
await fetch(
`${PAYSTACK_API_URL}/transaction/initialize`,
{
method:"POST",
headers:{
"Authorization":
`Bearer ${PAYSTACK_SECRET_KEY}`,
"Content-Type":
"application/json"
},
body:JSON.stringify({
email,
amount:amountKobo,
reference:referenceValue,
callback_url:
`${FRONTEND_URL}/wallet.html`
})
}
);

const data=
await response.json();

if(!response.ok||
!data.status){

await db(
`UPDATE payments
SET status='failed'
WHERE reference=$1`,
[
referenceValue
]
);

return{
success:false,
message:
data.message||
"Unable to initialize payment."
};

}

return{
success:true,
message:
"Payment initialized successfully.",
reference:
referenceValue,
authorization_url:
data.data?.authorization_url||"",
access_code:
data.data?.access_code||""
};

}catch(error){

console.error(
"PAYSTACK INITIALIZE ERROR:",
error
);

await db(
`UPDATE payments
SET status='failed'
WHERE reference=$1`,
[
referenceValue
]
);

return{
success:false,
message:
"Unable to connect to Paystack."
};

}

}


async function initializePayment(
userId,
email,
amount
){

return createPayment(
userId,
email,
amount
);

}


async function verifyPayment(
referenceValue,
expectedUserId=null
){

referenceValue=
clean(referenceValue);

if(!referenceValue){

return{
success:false,
message:
"Payment reference is required."
};

}

const paymentResult=
await db(
`SELECT *
FROM payments
WHERE reference=$1
LIMIT 1`,
[
referenceValue
]
);

if(!paymentResult.rows.length){

return{
success:false,
message:
"Payment record not found."
};

}

const payment=
paymentResult.rows[0];

if(expectedUserId && String(payment.user_id)!==String(expectedUserId)){
return{success:false,statusCode:403,message:"You cannot verify another user's payment."};
}

if(payment.credited){

return{
success:true,
message:
"Payment has already been credited.",
reference:
referenceValue,
status:
"success",
credited:true
};

}

if(!PAYSTACK_SECRET_KEY){

return{
success:false,
message:
"Paystack is not configured."
};

}

try{

const response=
await fetch(
`${PAYSTACK_API_URL}/transaction/verify/${encodeURIComponent(referenceValue)}`,
{
method:"GET",
headers:{
"Authorization":
`Bearer ${PAYSTACK_SECRET_KEY}`,
"Content-Type":
"application/json"
}
}
);

const data=
await response.json();

if(!response.ok||
!data.status){

return{
success:false,
message:
data.message||
"Unable to verify payment."
};

}

const transaction=
data.data;

if(
transaction.status!=="success"
){

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

await db(
`UPDATE payments
SET status='failed'
WHERE reference=$1`,
[
referenceValue
]
);

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

await client.query(
`SELECT id
FROM payments
WHERE reference=$1
FOR UPDATE`,
[
referenceValue
]
);

const latestPayment=
await client.query(
`SELECT *
FROM payments
WHERE reference=$1
FOR UPDATE`,
[
referenceValue
]
);

if(
!latestPayment.rows.length
){

await client.query(
"ROLLBACK"
);

return{
success:false,
message:
"Payment record not found."
};

}

const lockedPayment=
latestPayment.rows[0];

if(lockedPayment.credited){

await client.query(
"COMMIT"
);

return{
success:true,
message:
"Payment has already been credited.",
reference:
referenceValue,
status:
"success",
credited:true
};

}

await client.query(
`INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[
lockedPayment.user_id
]
);

const walletResult=
await client.query(
`UPDATE wallets
SET
balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2
RETURNING balance`,
[
Number(lockedPayment.amount),
lockedPayment.user_id
]
);

if(!walletResult.rows.length){

throw new Error(
"Wallet could not be updated."
);

}

await client.query(
`UPDATE payments
SET
status='success',
credited=TRUE,
credited_at=NOW()
WHERE reference=$1`,
[
referenceValue
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
lockedPayment.user_id,
Number(lockedPayment.amount),
referenceValue
]
);

await client.query(
"COMMIT"
);

return{
success:true,
message:
"Payment verified and wallet credited.",
reference:
referenceValue,
amount:
Number(lockedPayment.amount),
status:
"success",
credited:true,
balance:
Number(
walletResult.rows[0].balance
)
};

}catch(error){

await client.query(
"ROLLBACK"
);

console.error(
"PAYMENT CREDIT ERROR:",
error
);

return{
success:false,
message:
"Payment verification succeeded but wallet credit failed."
};

}finally{

client.release();

}

}catch(error){

console.error(
"PAYSTACK VERIFY ERROR:",
error
);

return{
success:false,
message:
"Unable to connect to Paystack."
};

}

}


async function debitWallet(
userId,
amount
){

if(!validAmount(amount)){

return{
success:false,
message:
"Invalid amount."
};

}

const client=
await pool.connect();

try{

await client.query(
"BEGIN"
);

const result=
await client.query(
`UPDATE wallets
SET
balance=balance-$1,
updated_at=NOW()
WHERE user_id=$2
AND balance>=$1
RETURNING balance`,
[
Number(amount),
userId
]
);

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

console.error(
"DEBIT WALLET ERROR:",
error
);

return{
success:false,
message:
"Unable to debit wallet."
};

}finally{

client.release();

}

}


async function refundWallet(userId, amount){
  if(!validAmount(amount)) return {success:false,message:"Invalid refund amount."};
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);
    const result=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[Number(amount),userId]);
    if(!result.rows.length){ await client.query("ROLLBACK"); return {success:false,message:"Unable to refund wallet."}; }
    await client.query("COMMIT");
    return {success:true,balance:Number(result.rows[0].balance)};
  }catch(error){
    try{await client.query("ROLLBACK");}catch{}
    console.error("REFUND WALLET ERROR:",error);
    return {success:false,message:"Unable to refund wallet."};
  }finally{client.release();}
}

async function markTransactionFailedAndRefund(referenceValue, reason, providerResponse=null){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query(`SELECT * FROM transactions WHERE reference=$1 FOR UPDATE`,[referenceValue]);
    if(!r.rows.length){await client.query("ROLLBACK");return {success:false,message:"Transaction not found."};}
    const t=r.rows[0];
    if(t.status==='refunded' || t.refunded_at){await client.query("COMMIT");return {success:true,alreadyRefunded:true,balance:(await getWallet(t.user_id))?.balance||0};}
    if(t.type!=='debit' || !['processing','pending','failed'].includes(String(t.status))){await client.query("ROLLBACK");return {success:false,message:"Transaction is not eligible for refund."};}
    await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[t.user_id]);
    const w=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[Number(t.amount),t.user_id]);
    if(!w.rows.length){await client.query("ROLLBACK");return {success:false,message:"Unable to refund wallet."};}
    const refundRef=`REF-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const meta={original_reference:referenceValue,reason,providerResponse};
    await client.query(`UPDATE transactions SET status='refunded',refunded_at=NOW(),completed_at=NOW(),metadata=COALESCE(metadata,'{}'::jsonb)||$1::jsonb WHERE reference=$2`,[JSON.stringify({refund:meta}),referenceValue]);
    await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,metadata) VALUES($1,'credit','Wallet refund',$2,$3,'successful',NOW(),$4)`,[t.user_id,Number(t.amount),refundRef,JSON.stringify(meta)]);
    await client.query("COMMIT");
    return {success:true,alreadyRefunded:false,balance:Number(w.rows[0].balance),refundReference:refundRef,userId:t.user_id,amount:Number(t.amount)};
  }catch(error){try{await client.query("ROLLBACK");}catch{};console.error("ATOMIC REFUND ERROR:",error);return {success:false,message:"Unable to complete refund."};}
  finally{client.release();}
}

async function finalizeVTUTransaction(referenceValue, providerData, pending, pricingMeta=null){
  const status=pending?'pending':'successful';
  const meta={providerResponse:providerData};
  if(pricingMeta)Object.assign(meta,{pricing:pricingMeta});
  const result=await db(`UPDATE transactions SET status=$1,provider_reference=$2,completed_at=CASE WHEN $1='successful' THEN NOW() ELSE completed_at END,metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE reference=$4 AND status IN ('processing','pending') RETURNING *`,[status,providerData?.reference||providerData?.data?.reference||null,JSON.stringify(meta),referenceValue]);
  return result.rows[0]||null;
}


async function insertTransaction({
userId,service,amount,reference,status,type="debit",idempotencyKey=null,
providerReference=null,recipient=null,metadata=null
}){
const result=await db(`
INSERT INTO transactions(
user_id,type,service,amount,reference,status,date,idempotency_key,
provider_reference,recipient,metadata
)
VALUES($1,$2,$3,$4,$5,$6,NOW(),$7,$8,$9,$10)
ON CONFLICT(idempotency_key) DO UPDATE SET reference=transactions.reference
RETURNING *`,[
userId,type,service,Number(amount),reference,status,idempotencyKey,
providerReference,recipient,metadata?JSON.stringify(metadata):null
]);
return result.rows[0];
}

async function addNotification(userId,title,message,type="info"){
try{await db(`INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4)`,[userId,title,message,type]);}
catch(error){console.error("NOTIFICATION ERROR:",error.message);}
}

function hashTransactionPin(pin){return hashPassword(String(pin));}
function verifyTransactionPin(pin,stored){return verifyPassword(String(pin),stored);}

async function getSecurity(userId){
const r=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1`,[userId]);
return r.rows[0]||null;
}

async function setTransactionPin(userId,pin,currentPin=""){
if(!/^\d{4}$/.test(String(pin||""))) return {success:false,message:"Transaction PIN must contain exactly 4 digits."};
const existing=await getSecurity(userId);
if(existing?.transaction_pin_hash){
if(!currentPin || !verifyTransactionPin(currentPin,existing.transaction_pin_hash)) return {success:false,message:"Current transaction PIN is incorrect."};
}
await db(`INSERT INTO user_security(user_id,transaction_pin_hash,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET transaction_pin_hash=EXCLUDED.transaction_pin_hash,updated_at=NOW()`,[userId,hashTransactionPin(pin)]);
return {success:true,message:existing?.transaction_pin_hash?"Transaction PIN changed successfully.":"Transaction PIN created successfully."};
}

async function requireTransactionPin(userId,pin){
const security=await getSecurity(userId);
if(!security?.transaction_pin_hash) return {success:false,required:true,code:"TRANSACTION_PIN_NOT_SET",message:"Set your 4-digit transaction PIN before making a transaction."};
if(!pin || !verifyTransactionPin(pin,security.transaction_pin_hash)) return {success:false,required:true,code:"INVALID_TRANSACTION_PIN",message:"Incorrect transaction PIN."};
return {success:true,required:true};
}


const PAYSTACK_API_URL=
"https://api.paystack.co";

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

try{

const response=
await fetch(
VTU_API_URL,
{
method:"POST",
headers:{
"Content-Type":
"application/json",
"Authorization":
`Bearer ${VTU_API_KEY}`
},
body:JSON.stringify(
payload||{}
)
}
);

let data={};

try{

data=
await response.json();

}catch(error){

data={};

}

return{
success:
response.ok,
configured:true,
statusCode:
response.status,
data
};

}catch(error){

console.error(
"VTU PROVIDER REQUEST ERROR:",
error
);

throw error;

}

}



function pricingConfig(service){
  const cfg=service?.config&&typeof service.config==='object'?service.config:{};
  const pricing=cfg.pricing&&typeof cfg.pricing==='object'?cfg.pricing:{};
  const mode=String(pricing.mode||'discount').toLowerCase();
  const discount=Number(pricing.discount_pct||0);
  const fixedProfit=Number(pricing.fixed_profit||0);
  return {
    mode:['discount','fixed'].includes(mode)?mode:'discount',
    discount_pct:Number.isFinite(discount)&&discount>=0?discount:0,
    fixed_profit:Number.isFinite(fixedProfit)&&fixedProfit>=0?fixedProfit:0
  };
}

function estimatedProviderCost(service,customerAmount){
  const rule=pricingConfig(service);
  const amount=Number(customerAmount);
  let cost=amount;
  let source='no_pricing_rule';
  if(rule.mode==='fixed'&&rule.fixed_profit>0){
    cost=Math.max(0,amount-rule.fixed_profit);
    source='fixed_profit';
  }else if(rule.mode==='discount'&&rule.discount_pct>0){
    cost=Math.max(0,amount*(1-rule.discount_pct/100));
    source='discount_pct';
  }
  return {cost:Number(cost.toFixed(2)),source,rule};
}

function providerCostFromResponse(providerData,customerAmount){
  const candidates=[
    providerData?.provider_cost,
    providerData?.cost,
    providerData?.charged_amount,
    providerData?.amount_charged,
    providerData?.data?.provider_cost,
    providerData?.data?.cost,
    providerData?.data?.charged_amount,
    providerData?.data?.amount_charged
  ];
  for(const value of candidates){
    const n=Number(value);
    if(Number.isFinite(n)&&n>=0)return Number(n.toFixed(2));
  }
  return null;
}

async function processVTUTransaction(user,data){
if(Boolean(await getPlatformSetting('maintenance_mode',false)))return{success:false,statusCode:503,message:'BOLTIV is currently in maintenance mode. Transactions are temporarily disabled.'};
const service=await getService(data.service);
if(service&&(!service.enabled||service.maintenance))return{success:false,statusCode:503,message:`${service.name} is currently unavailable.`};
if(user.status==="suspended") return {success:false,statusCode:403,message:"Your account is suspended. Transactions are disabled."};
const userId=user.user_id;
const amount=Number(data.amount);
if(!userId) return {success:false,statusCode:400,message:"User ID is required."};
if(!validAmount(amount)) return {success:false,statusCode:400,message:"Invalid amount."};
const pricing=estimatedProviderCost(service,amount);
if(pricing.cost>amount){return {success:false,statusCode:400,message:"Service pricing would cost more than the customer price. Update the service pricing before enabling sales."};}
const pinCheck=await requireTransactionPin(userId,data.transactionPin||"");
if(!pinCheck.success) return {success:false,statusCode:401,message:pinCheck.message,code:"INVALID_TRANSACTION_PIN"};
const rawIdempotencyKey=clean(data.idempotencyKey)||crypto.randomUUID();
const idempotencyKey=crypto.createHash("sha256").update(`${userId}:${rawIdempotencyKey}`).digest("hex");
const existing=await db(`SELECT * FROM transactions WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1`,[userId,idempotencyKey]);
if(existing.rows.length){
const t=existing.rows[0];
return {success:t.status==="successful",statusCode:t.status==="successful"?200:409,message:t.status==="successful"?"Transaction already completed.":"This transaction is already being processed.",reference:t.reference,status:t.status,amount:Number(t.amount),balance:(await getWallet(userId))?.balance||0};
}
await createWallet(userId);
const client=await pool.connect();
let referenceValue=reference("BOLTIV-TX");
try{
await client.query("BEGIN");
const debit=await client.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[amount,userId]);
if(!debit.rows.length){await client.query("ROLLBACK");return {success:false,statusCode:400,message:"Insufficient wallet balance.",balance:(await getWallet(userId))?.balance||0};}
await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,idempotency_key,recipient,metadata) VALUES($1,'debit',$2,$3,$4,'processing',NOW(),$5,$6,$7)`,[userId,data.service||"VTU Service",amount,referenceValue,idempotencyKey,data.recipient||null,data.metadata?JSON.stringify(data.metadata):null]);
await client.query("COMMIT");
}catch(error){try{await client.query("ROLLBACK");}catch{} client.release(); console.error("TRANSACTION RESERVE ERROR:",error); return {success:false,statusCode:500,message:"Unable to start transaction."};}
client.release();
let providerResult;
try{providerResult=await callVTUProvider(data.providerPayload||data);}catch(error){providerResult={success:false,configured:true,data:{},error:true};}
if(!providerResult.configured){const refundResult=await markTransactionFailedAndRefund(referenceValue,"provider_not_configured"); if(!refundResult.success) return {success:false,statusCode:500,message:refundResult.message,reference:referenceValue,status:"processing"};await addNotification(userId,"Transaction failed","Your BOLTIV transaction was refunded because the service provider is not configured yet.","error");return {success:false,statusCode:503,message:providerResult.message,reference:referenceValue,status:"failed",balance:(await getWallet(userId))?.balance||0};}
const providerData=providerResult.data||{};
const actualProviderCost=providerCostFromResponse(providerData,amount);
const providerCost=actualProviderCost===null?pricing.cost:actualProviderCost;
const pricingSource=actualProviderCost===null?pricing.source:'provider_response';
const grossProfit=Number((amount-providerCost).toFixed(2));
if(!providerResult.success){
const refundResult=await markTransactionFailedAndRefund(referenceValue,"provider_failed",providerData); if(!refundResult.success) return {success:false,statusCode:500,message:refundResult.message,reference:referenceValue,status:"processing"};
await addNotification(userId,"Transaction failed",`${data.service||"Service"} failed and your wallet was refunded. Reference: ${referenceValue}`,"error");
return {success:false,statusCode:400,message:"VTU transaction failed. Your wallet has been refunded.",reference:referenceValue,status:"failed",balance:(await getWallet(userId))?.balance||0};
}
const providerStatus=String(providerData.status||providerData.data?.status||"successful").toLowerCase();
const pending=["pending","processing","queued","in_progress"].includes(providerStatus);
const finalStatus=pending?"pending":"successful";
const finalized=await finalizeVTUTransaction(referenceValue,providerData,pending,{customerAmount:amount,providerCost,grossProfit,pricingSource,pricingRule:pricing.rule}); if(!finalized) return {success:false,statusCode:409,message:"Transaction state changed while processing. Check transaction history.",reference:referenceValue,status:"processing"};
await addNotification(userId,pending?"Transaction processing":"Transaction successful",pending?`${data.service||"Service"} is still processing. Reference: ${referenceValue}`:`${data.service||"Service"} was completed successfully. Reference: ${referenceValue}`,pending?"pending":"success");
const finalWallet=await getWallet(userId);
return {success:true,message:pending?`${data.service} is being processed.`:`${data.service} purchase successful.`,reference:referenceValue,amount,status:finalStatus,balance:finalWallet?.balance||0,data:providerData};
}


async function reconcilePendingTransactions(admin,req){
  const r=await db(`SELECT id,user_id,service,amount,reference,status,provider_reference,date FROM transactions WHERE type='debit' AND status IN ('processing','pending') ORDER BY date ASC LIMIT 100`);
  return {success:true,count:r.rows.length,transactions:r.rows.map(t=>({...t,amount:Number(t.amount)}))};
}

async function getPlatformSetting(key,fallback=null){const r=await db(`SELECT value FROM platform_settings WHERE key=$1`,[key]);return r.rows.length?r.rows[0].value:fallback;}
async function setPlatformSetting(key,value){await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[key,JSON.stringify(value)]);}
function serviceKey(value){const v=clean(value).toLowerCase();return ({airtime:'airtime',data:'data',electricity:'electricity',cable:'cable','cable tv':'cable',education:'education'})[v]||v;}
async function getService(key){const r=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services WHERE key=$1`,[serviceKey(key)]);return r.rows[0]||null;}
async function recordSecurityEvent(eventType,severity,details={},req=null,adminId=null){await db(`INSERT INTO security_events(admin_id,event_type,severity,details,ip) VALUES($1,$2,$3,$4::jsonb,$5)`,[adminId,eventType,severity,JSON.stringify(details),req?requestIp(req):null]);}

async function adminServices(req,action){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};if(action==='list'){const r=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services ORDER BY key`);return{success:true,services:r.rows};}const b=await body(req);const key=serviceKey(b.key||b.service);const existing=await getService(key);if(!existing)return{success:false,statusCode:404,message:'Service not found.'};const enabled=b.enabled===undefined?existing.enabled:Boolean(b.enabled);const maintenance=b.maintenance===undefined?existing.maintenance:Boolean(b.maintenance);const fee=b.fee===undefined?Number(existing.fee||0):Number(b.fee);if(!Number.isFinite(fee)||fee<0)return{success:false,statusCode:400,message:'Invalid service fee.'};const incomingConfig=b.config===undefined?{}:(b.config||{});const oldConfig=existing.config&&typeof existing.config==='object'?existing.config:{};const config={...oldConfig,...incomingConfig,pricing:{...(oldConfig.pricing||{}),...(incomingConfig.pricing||{})}};if(config.pricing){const mode=String(config.pricing.mode||'discount').toLowerCase();const discount=Number(config.pricing.discount_pct||0);const fixed=Number(config.pricing.fixed_profit||0);if(!['discount','fixed'].includes(mode)||!Number.isFinite(discount)||discount<0||discount>100||!Number.isFinite(fixed)||fixed<0)return{success:false,statusCode:400,message:'Invalid pricing configuration.'};config.pricing={mode,discount_pct:discount,fixed_profit:fixed};}const r=await db(`UPDATE services SET enabled=$1,maintenance=$2,fee=$3,config=$4::jsonb,updated_at=NOW() WHERE key=$5 RETURNING key,name,icon,enabled,fee,maintenance,config,updated_at`,[enabled,maintenance,fee,JSON.stringify(config),key]);await adminAudit(admin,'service_updated','service',key,{enabled,maintenance,fee,config},req);return{success:true,service:r.rows[0]};}
async function adminSettings(req,action){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};if(action==='get')return{success:true,settings:{maintenance_mode:Boolean(await getPlatformSetting('maintenance_mode',false)),registration_enabled:Boolean(await getPlatformSetting('registration_enabled',true))}};const b=await body(req);if(b.maintenance_mode!==undefined)await setPlatformSetting('maintenance_mode',Boolean(b.maintenance_mode));if(b.registration_enabled!==undefined)await setPlatformSetting('registration_enabled',Boolean(b.registration_enabled));const settings={maintenance_mode:Boolean(await getPlatformSetting('maintenance_mode',false)),registration_enabled:Boolean(await getPlatformSetting('registration_enabled',true))};await adminAudit(admin,'platform_settings_updated','settings','platform',settings,req);return{success:true,settings};}
async function adminSecurity(req,action){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};if(action==='events'){const r=await db(`SELECT s.*,a.email FROM security_events s LEFT JOIN admins a ON a.id=s.admin_id ORDER BY s.created_at DESC LIMIT 500`);return{success:true,events:r.rows};}if(action==='sessions'){const r=await db(`SELECT id,created_at,expires_at FROM admin_sessions WHERE admin_id=$1 AND expires_at>NOW() ORDER BY created_at DESC`,[admin.id]);return{success:true,sessions:r.rows};}if(action==='revoke'){const auth=String(req.headers.authorization||'');const current=auth.startsWith('Bearer ')?auth.slice(7).trim():'';const r=await db(`DELETE FROM admin_sessions WHERE admin_id=$1 AND token<>$2`,[admin.id,current]);await recordSecurityEvent('sessions_revoked','warning',{revoked:Number(r.rowCount||0)},req,admin.id);await adminAudit(admin,'sessions_revoked','admin',String(admin.id),{revoked:Number(r.rowCount||0)},req);return{success:true,revoked:Number(r.rowCount||0)};}return{success:false,statusCode:400,message:'Unknown security action.'};}

async function adminAudit(admin,action,targetType,targetId,details,req){
try{
await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip)
VALUES($1,$2,$3,$4,$5,$6)`,[
admin?.id||null,action,targetType||null,targetId||null,
JSON.stringify(details||{}),
req?.headers?.["x-forwarded-for"]||req?.socket?.remoteAddress||null
]);
}catch(e){console.error("ADMIN AUDIT ERROR:",e.message);}
}

async function adminUserAction(req){
const admin=await adminFromToken(req);
if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
const b=await body(req), target=clean(b.userId||b.id), action=clean(b.action);
if(!target||!["suspend","activate"].includes(action))
return{success:false,statusCode:400,message:"Invalid user action."};
const r=await db(`SELECT user_id,email FROM users WHERE user_id=$1 OR id::text=$1 LIMIT 1`,[target]);
if(!r.rows.length)return{success:false,statusCode:404,message:"User not found."};
const u=r.rows[0],status=action==="suspend"?"suspended":"active";
await db(`UPDATE users SET status=$1,updated_at=NOW() WHERE user_id=$2`,[status,u.user_id]);
if(action==="suspend") await db(`DELETE FROM user_sessions WHERE user_id=(SELECT id FROM users WHERE user_id=$1)`,[u.user_id]);
await addNotification(u.user_id,action==="suspend"?"Account suspended":"Account activated",
action==="suspend"?"Your BOLTIV account has been suspended. Please contact support.":"Your BOLTIV account has been activated.","security");
await adminAudit(admin,`user_${action}`,"user",u.user_id,{email:u.email},req);
return{success:true,message:`User ${status}.`,status};
}

async function ensureAdminWallet(client,adminId){await client.query(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);}
async function getAdminWallet(adminId){const r=await db(`SELECT admin_id,balance,created_at,updated_at FROM admin_wallets WHERE admin_id=$1`,[adminId]);return r.rows.length?{...r.rows[0],balance:Number(r.rows[0].balance||0)}:{admin_id:adminId,balance:0};}
async function addAdminLedger(client,adminId,type,amount,balanceAfter,description,reference){await client.query(`INSERT INTO admin_wallet_ledger(admin_id,type,amount,balance_after,reference,description) VALUES($1,$2,$3,$4,$5,$6)`,[adminId,type,amount,balanceAfter,reference,description]);}
async function creditAdminFromPayment(client,payment){await ensureAdminWallet(client,payment.admin_id);const wr=await client.query(`UPDATE admin_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(payment.amount),payment.admin_id]);if(!wr.rows.length)throw new Error('Admin wallet update failed.');const balanceAfter=Number(wr.rows[0].balance);await addAdminLedger(client,payment.admin_id,'funding',Number(payment.amount),balanceAfter,'Paystack admin wallet funding',`AF-${payment.reference}`);await client.query(`UPDATE payments SET status='success',credited=TRUE,credited_at=NOW() WHERE reference=$1`,[payment.reference]);return balanceAfter;}
async function adminWalletInfo(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};const wallet=await getAdminWallet(admin.id);const ledger=(await db(`SELECT id,type,amount,balance_after,reference,description,created_at FROM admin_wallet_ledger WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 100`,[admin.id])).rows.map(x=>({...x,amount:Number(x.amount||0),balance_after:Number(x.balance_after||0)}));return{success:true,wallet,ledger};}
async function initializeAdminWalletFunding(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};if(!PAYSTACK_SECRET_KEY)return{success:false,statusCode:503,message:'Paystack is not configured.'};const b=await body(req),amount=Number(b.amount);if(!validAmount(amount)||amount<100)return{success:false,statusCode:400,message:'Enter an amount of at least ₦100.'};const ref=reference('ADM-FUND');await db(`INSERT INTO payments(reference,user_id,email,amount,amount_kobo,status,credited,recipient_type,admin_id,created_at) VALUES($1,$2,$3,$4,$5,'pending',FALSE,'admin',$6,NOW())`,[ref,`ADMIN:${admin.id}`,admin.email,amount,Math.round(amount*100),admin.id]);try{const response=await fetch(`${PAYSTACK_API_URL}/transaction/initialize`,{method:'POST',headers:{Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({email:admin.email,amount:Math.round(amount*100),reference:ref,callback_url:`${FRONTEND_URL}/admin.html?admin_funding=${encodeURIComponent(ref)}`})});const data=await response.json();if(!response.ok||!data.status){await db(`UPDATE payments SET status='failed' WHERE reference=$1`,[ref]);return{success:false,statusCode:400,message:data.message||'Unable to initialize payment.'};}return{success:true,reference:ref,authorization_url:data.data?.authorization_url||''};}catch(e){await db(`UPDATE payments SET status='failed' WHERE reference=$1`,[ref]);return{success:false,statusCode:502,message:'Unable to connect to Paystack.'};}}
async function verifyAdminWalletFunding(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};if(!PAYSTACK_SECRET_KEY)return{success:false,statusCode:503,message:'Paystack is not configured.'};const b=await body(req),ref=clean(b.reference);if(!ref)return{success:false,statusCode:400,message:'Payment reference is required.'};const pr=await db(`SELECT * FROM payments WHERE reference=$1 AND recipient_type='admin' AND admin_id=$2 LIMIT 1`,[ref,admin.id]);if(!pr.rows.length)return{success:false,statusCode:404,message:'Admin funding payment not found.'};const payment=pr.rows[0];if(payment.credited)return{success:true,message:'Admin wallet has already been funded.',reference:ref,balance:(await getAdminWallet(admin.id)).balance};const response=await fetch(`${PAYSTACK_API_URL}/transaction/verify/${encodeURIComponent(ref)}`,{headers:{Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json'}});const data=await response.json();if(!response.ok||!data.status)return{success:false,statusCode:400,message:data.message||'Unable to verify payment.'};const tx=data.data||{};if(tx.status!=='success'){await db(`UPDATE payments SET status=$1 WHERE reference=$2`,[tx.status,ref]);return{success:false,statusCode:400,message:`Payment status: ${tx.status}`};}if(Number(tx.amount)!==Number(payment.amount_kobo))return{success:false,statusCode:400,message:'Payment amount does not match.'};const client=await pool.connect();try{await client.query('BEGIN');const locked=(await client.query(`SELECT * FROM payments WHERE reference=$1 FOR UPDATE`,[ref])).rows[0];if(!locked||locked.credited){await client.query('COMMIT');return{success:true,message:'Admin wallet has already been funded.',reference:ref,balance:(await getAdminWallet(admin.id)).balance};}const balance=await creditAdminFromPayment(client,locked);await client.query('COMMIT');await adminAudit(admin,'admin_wallet_funded','admin_wallet',String(admin.id),{amount:Number(payment.amount),reference:ref},req);return{success:true,message:'Admin wallet funded successfully.',reference:ref,balance};}catch(e){try{await client.query('ROLLBACK')}catch{}return{success:false,statusCode:500,message:'Unable to credit admin wallet.'};}finally{client.release();}}

async function adminWalletAdjust(req,mode){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};const b=await body(req),target=clean(b.userId||b.id),amount=Number(b.amount),reason=clean(b.reason||"Admin wallet transfer");if(!target||!Number.isFinite(amount)||amount<=0)return{success:false,statusCode:400,message:"Enter a valid amount."};const r=await db(`SELECT user_id,email FROM users WHERE user_id=$1 OR id::text=$1 LIMIT 1`,[target]);if(!r.rows.length)return{success:false,statusCode:404,message:"User not found."};const u=r.rows[0],c=await pool.connect();try{await c.query("BEGIN");await ensureAdminWallet(c,admin.id);const ref=`ADM-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;if(mode==="credit"){const ar=await c.query(`UPDATE admin_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2 AND balance>=$1 RETURNING balance`,[amount,admin.id]);if(!ar.rows.length){await c.query("ROLLBACK");return{success:false,statusCode:400,message:"Insufficient admin wallet balance. Fund the admin wallet first."};}const adminBalance=Number(ar.rows[0].balance);await c.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[u.user_id]);const wr=await c.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[amount,u.user_id]);await addAdminLedger(c,admin.id,'transfer_out',amount,adminBalance,`Transfer to ${u.email}: ${reason}`,ref);await c.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,metadata) VALUES($1,'credit','Admin wallet transfer',$2,$3,'successful',NOW(),$4)`,[u.user_id,amount,ref,JSON.stringify({admin_id:admin.id,reason,source:'admin_wallet'})]);await c.query("COMMIT");await adminAudit(admin,'wallet_credit_from_admin_wallet','user',u.user_id,{amount,reason,reference:ref,adminBalance},req);await addNotification(u.user_id,'Wallet credited',`Your wallet was credited with ₦${amount.toLocaleString()}. Reason: ${reason}`,'payment');return{success:true,message:'Wallet credited from admin wallet.',balance:Number(wr.rows[0].balance),adminBalance,reference:ref};}const wr=await c.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[amount,u.user_id]);if(!wr.rows.length){await c.query("ROLLBACK");return{success:false,statusCode:400,message:"Insufficient user wallet balance."};}const userBalance=Number(wr.rows[0].balance);const ar=await c.query(`UPDATE admin_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[amount,admin.id]);const adminBalance=Number(ar.rows[0].balance);await addAdminLedger(c,admin.id,'transfer_in',amount,adminBalance,`Transfer from ${u.email}: ${reason}`,ref);await c.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,metadata) VALUES($1,'debit','Admin wallet transfer',$2,$3,'successful',NOW(),$4)`,[u.user_id,amount,ref,JSON.stringify({admin_id:admin.id,reason,destination:'admin_wallet'})]);await c.query("COMMIT");await adminAudit(admin,'wallet_debit_to_admin_wallet','user',u.user_id,{amount,reason,reference:ref,adminBalance},req);await addNotification(u.user_id,'Wallet debited',`Your wallet was debited by ₦${amount.toLocaleString()}. Reason: ${reason}`,'payment');return{success:true,message:'User wallet debited to admin wallet.',balance:userBalance,adminBalance,reference:ref};}catch(e){try{await c.query("ROLLBACK")}catch{}console.error('ADMIN WALLET TRANSFER ERROR',e);return{success:false,statusCode:500,message:"Unable to adjust wallet."};}finally{c.release();}}

async function adminRefund(req){
const admin=await adminFromToken(req);
if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
const b=await body(req),ref=clean(b.reference);
if(!ref)return{success:false,statusCode:400,message:"Transaction reference is required."};
const c=await pool.connect();
try{
await c.query("BEGIN");
const r=await c.query(`SELECT * FROM transactions WHERE reference=$1 FOR UPDATE`,[ref]);
if(!r.rows.length){await c.query("ROLLBACK");return{success:false,statusCode:404,message:"Transaction not found."};}
const t=r.rows[0];
if(t.type!=="debit"||t.status==="refunded"||t.refunded_at){await c.query("ROLLBACK");return{success:false,statusCode:400,message:"Transaction cannot be refunded."};}
const amount=Number(t.amount);
await c.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[t.user_id]);
const wr=await c.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[amount,t.user_id]);
const refundRef=`REF-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
await c.query(`UPDATE transactions SET status='refunded',metadata=COALESCE(metadata,'{}'::jsonb)||$1::jsonb WHERE reference=$2`,
[JSON.stringify({refunded_by:admin.id,reason:clean(b.reason||"Admin refund")}),ref]);
await c.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,metadata)
VALUES($1,'credit','Refund',$2,$3,'successful',NOW(),$4)`,
[t.user_id,amount,refundRef,JSON.stringify({original_reference:ref,admin_id:admin.id})]);
await c.query("COMMIT");
await adminAudit(admin,"transaction_refund","transaction",ref,{amount,refundReference:refundRef},req);
await addNotification(t.user_id,"Transaction refunded",`₦${amount.toLocaleString()} has been refunded to your wallet. Reference: ${ref}`,"payment");
return{success:true,message:"Transaction refunded successfully.",balance:Number(wr.rows[0].balance),refundReference:refundRef};
}catch(e){try{await c.query("ROLLBACK")}catch{};return{success:false,statusCode:500,message:"Unable to refund transaction."};}
finally{c.release();}
}

async function adminNotifications(req){
const admin=await adminFromToken(req);
if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
const b=await body(req),title=clean(b.title),message=clean(b.message),type=clean(b.type||"general"),recipient=clean(b.recipient||"all");
if(title.length<2||message.length<2)return{success:false,statusCode:400,message:"Title and message are required."};
let r;
if(recipient==="selected"){
const key=clean(b.userId||"");
r=await db(`SELECT user_id FROM users WHERE user_id=$1 OR id::text=$1 OR lower(email)=lower($1) LIMIT 1`,[key]);
}else if(recipient==="active")r=await db(`SELECT user_id FROM users WHERE status='active'`);
else r=await db(`SELECT user_id FROM users`);
if(!r.rows.length)return{success:false,statusCode:404,message:"No matching users."};
const c=await pool.connect();
try{
await c.query("BEGIN");
for(const u of r.rows)await c.query(`INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4)`,[u.user_id,title,message,type]);
await c.query("COMMIT");
await adminAudit(admin,"notification_send","notification",null,{recipient,count:r.rows.length,type,title},req);
return{success:true,message:`Notification sent to ${r.rows.length} user${r.rows.length===1?"":"s"}.`,count:r.rows.length};
}catch(e){try{await c.query("ROLLBACK")}catch{};return{success:false,statusCode:500,message:"Unable to send notification."};}
finally{c.release();}
}

async function adminSupport(req,action){
const admin=await adminFromToken(req);
if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
if(req.method==="GET")return{success:true,tickets:(await db(`SELECT t.*,u.name,u.email FROM support_tickets t LEFT JOIN users u ON u.user_id=t.user_id ORDER BY t.updated_at DESC LIMIT 500`)).rows};
const b=await body(req),id=Number(b.ticketId);
const tr=await db(`SELECT * FROM support_tickets WHERE id=$1`,[id]);
if(!tr.rows.length)return{success:false,statusCode:404,message:"Ticket not found."};
const t=tr.rows[0];
if(action==="reply"){
const m=clean(b.message);
if(m.length<2)return{success:false,statusCode:400,message:"Reply required."};
await db(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'admin',$2,$3)`,[id,String(admin.id),m]);
await db(`UPDATE support_tickets SET status='pending',updated_at=NOW() WHERE id=$1`,[id]);
await addNotification(t.user_id,"Support ticket update",`Admin replied to support ticket #${id}.`,"general");
await adminAudit(admin,"support_reply","ticket",String(id),{},req);
return{success:true,message:"Reply sent."};
}
const status=["open","pending","resolved","closed"].includes(b.status)?b.status:null;
if(!status)return{success:false,statusCode:400,message:"Invalid status."};
await db(`UPDATE support_tickets SET status=$1,updated_at=NOW() WHERE id=$2`,[status,id]);
await adminAudit(admin,"support_status","ticket",String(id),{status},req);
return{success:true,message:"Ticket status updated.",status};
}

async function adminAuditResponse(req){
const admin=await adminFromToken(req);
if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
return{success:true,logs:(await db(`SELECT a.*,ad.email FROM admin_audit_logs a LEFT JOIN admins ad ON ad.id=a.admin_id ORDER BY a.created_at DESC LIMIT 500`)).rows};
}

async function adminStats(){

const usersResult=
await db(
`SELECT COUNT(*)::int AS count
FROM users`
);

const walletResult=
await db(
`SELECT COALESCE(
SUM(balance),0
) AS balance
FROM wallets`
);

const transactionsResult=
await db(
`SELECT COUNT(*)::int AS count
FROM transactions`
);

const paymentsResult=
await db(
`SELECT COUNT(*)::int AS count
FROM payments`
);

const transactionStatusResult=
await db(
`SELECT
COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('successful','success','completed'))::int AS successful,
COUNT(*) FILTER (WHERE LOWER(COALESCE(status,''))='pending')::int AS pending,
COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('failed','failure'))::int AS failed
FROM transactions`
);

const activeUsersResult=
await db(
`SELECT COUNT(*)::int AS count
FROM users
WHERE LOWER(COALESCE(status,'active'))='active'`
);

const profitResult=await db(
`SELECT COALESCE(SUM(CASE WHEN type='debit' AND status='successful' THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS profit
FROM transactions`
);
const adminWalletResult=await db(`SELECT COALESCE(SUM(balance),0) AS balance FROM admin_wallets`);

return{
users:Number(usersResult.rows[0]?.count||0),
walletBalance:Number(walletResult.rows[0]?.balance||0),
transactions:Number(transactionsResult.rows[0]?.count||0),
payments:Number(paymentsResult.rows[0]?.count||0),
successful:Number(transactionStatusResult.rows[0]?.successful||0),
pending:Number(transactionStatusResult.rows[0]?.pending||0),
failed:Number(transactionStatusResult.rows[0]?.failed||0),
activeUsers:Number(activeUsersResult.rows[0]?.count||0),
grossProfit:Number(profitResult.rows[0]?.profit||0),
adminWalletBalance:Number(adminWalletResult.rows[0]?.balance||0)
};

}


async function adminUsers(){

const result=
await db(
`SELECT
u.id,
u.user_id,
u.name,
u.phone,
u.email,
u.created_at,
u.updated_at,
u.status,
COALESCE(
w.balance,
0
) AS balance
FROM users u
LEFT JOIN wallets w
ON w.user_id=u.user_id
ORDER BY u.created_at DESC
LIMIT 500`
);

return result.rows.map(user=>({
id:user.id,
user_id:user.user_id,
name:user.name,
phone:user.phone,
email:user.email,
balance:Number(
user.balance||0
),
created_at:user.created_at,
updated_at:user.updated_at,
status:user.status||"active"
}));

}


async function adminTransactions(){

const result=
await db(
`SELECT
t.id,
t.user_id,
t.type,
t.service,
t.amount,
t.reference,
t.status,
t.date,
t.metadata,
u.name,
u.email
FROM transactions t
LEFT JOIN users u
ON u.user_id=t.user_id
ORDER BY t.date DESC
LIMIT 500`
);

return result.rows.map(item=>({
id:item.id,
user_id:item.user_id,
name:item.name||"",
email:item.email||"",
type:item.type,
service:item.service,
amount:Number(
item.amount||0
),
reference:item.reference,
status:item.status,
date:item.date,
metadata:item.metadata||{},
grossProfit:Number(item.metadata?.pricing?.grossProfit||0),
providerCost:Number(item.metadata?.pricing?.providerCost||0)
}));

}


async function adminPayments(){

const result=
await db(
`SELECT
p.reference,
p.user_id,
p.email,
p.amount,
p.amount_kobo,
p.status,
p.credited,
p.created_at,
p.credited_at,
u.name
FROM payments p
LEFT JOIN users u
ON u.user_id=p.user_id
ORDER BY p.created_at DESC
LIMIT 500`
);

return result.rows.map(item=>({
reference:item.reference,
user_id:item.user_id,
name:item.name||"",
email:item.email,
amount:Number(
item.amount||0
),
amount_kobo:Number(
item.amount_kobo||0
),
status:item.status,
credited:Boolean(
item.credited
),
created_at:item.created_at,
credited_at:item.credited_at
}));

}


async function adminMe(req){

const admin=
await adminFromToken(req);

if(!admin){

return{
success:false,
statusCode:401,
message:
"Unauthorized."
};

}

return{
success:true,
admin:{
id:admin.id,
email:admin.email
}
};

}


async function adminStatsResponse(req){

const admin=
await adminFromToken(req);

if(!admin){

return{
success:false,
statusCode:401,
message:
"Unauthorized."
};

}

const stats=
await adminStats();

return{
success:true,
stats
};

}


async function adminUsersResponse(req){

const admin=
await adminFromToken(req);

if(!admin){

return{
success:false,
statusCode:401,
message:
"Unauthorized."
};

}

const users=
await adminUsers();

return{
success:true,
users
};

}


async function adminTransactionsResponse(req){

const admin=
await adminFromToken(req);

if(!admin){

return{
success:false,
statusCode:401,
message:
"Unauthorized."
};

}

const transactions=
await adminTransactions();

return{
success:true,
transactions
};

}


async function adminPaymentsResponse(req){

const admin=
await adminFromToken(req);

if(!admin){

return{
success:false,
statusCode:401,
message:
"Unauthorized."
};

}

const payments=
await adminPayments();

return{
success:true,
payments
};

}


async function handleAdminRoutes(
req,
res,
path
){

/*
ADMIN LOGIN
*/

if(
req.method==="POST"&&
path==="/api/admin/login"
){

const b=
await body(req);

const result=
await adminLogin(
b.email,
b.password,req
);

return send(
res,
result.success?200:401,
result
);

}


/*
ADMIN SESSION CHECK
*/

if(
req.method==="GET"&&
path==="/api/admin/me"
){

const result=
await adminMe(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN STATS
*/

if(
req.method==="GET"&&
path==="/api/admin/stats"
){

const result=
await adminStatsResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN USERS
*/

if(
req.method==="GET"&&
path==="/api/admin/users"
){

const result=
await adminUsersResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN TRANSACTIONS
*/

if(
req.method==="GET"&&
path==="/api/admin/transactions"
){

const result=
await adminTransactionsResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN PAYMENTS
*/

if(
req.method==="GET"&&
path==="/api/admin/payments"
){

const result=
await adminPaymentsResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


if(req.method==="GET"&&path==="/api/admin/wallet"){const result=await adminWalletInfo(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/fund/initialize"){const result=await initializeAdminWalletFunding(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/fund/verify"){const result=await verifyAdminWalletFunding(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/users/action"){const result=await adminUserAction(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/credit"){const result=await adminWalletAdjust(req,"credit");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/debit"){const result=await adminWalletAdjust(req,"debit");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/transactions/pending"){const admin=await requireAdmin(req); if(!admin)return; const result=await reconcilePendingTransactions(admin,req); return send(res,200,result);}
if(req.method==="POST"&&path==="/api/admin/transactions/refund"){const result=await adminRefund(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/notifications"){const result=await adminNotifications(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/support"){const result=await adminSupport(req,"list");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/support/reply"){const result=await adminSupport(req,"reply");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/support/status"){const result=await adminSupport(req,"status");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/audit"){const result=await adminAuditResponse(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/services"){const result=await adminServices(req,"list");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path==="/api/admin/services"){const result=await adminServices(req,"update");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/settings"){const result=await adminSettings(req,"get");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path==="/api/admin/settings"){const result=await adminSettings(req,"update");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/security/events"){const result=await adminSecurity(req,"events");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/security/sessions"){const result=await adminSecurity(req,"sessions");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/security/revoke-sessions"){const result=await adminSecurity(req,"revoke");return send(res,result.success?200:(result.statusCode||400),result);}

/*
ADMIN LOGOUT
*/

if(
req.method==="POST"&&
path==="/api/admin/logout"
){

const result=
await logoutAdmin(req);

return send(
res,
200,
result
);

}

return null;

}


async function handlePasswordRoutes(
req,
res,
path
){

/*
FORGOT PASSWORD
*/

if(
req.method==="POST"&&
path==="/api/auth/forgot-password"
){
const rl=rateLimit(req,"forgot-password",5,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=
await body(req);

const result=
await requestPasswordReset(
b.email
);

return send(
res,
result.success?
200:
400,
result
);

}


/*
RESET PASSWORD
*/

if(
req.method==="POST"&&
path==="/api/auth/reset-password"
){
const rl=rateLimit(req,"reset-password",8,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=
await body(req);

const result=
await resetPassword(
b.token,
b.password
);

return send(
res,
result.success?
200:
400,
result
);

}

return null;

}


async function handleAuthRoutes(
req,
res,
path
){

/*
REGISTER
*/

if(
req.method==="POST"&&
path==="/api/auth/register"
){
const rl=rateLimit(req,"register",5,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
if(!Boolean(await getPlatformSetting('registration_enabled',true)))return send(res,403,{success:false,message:'New user registration is currently disabled.'});
const b=
await body(req);

const result=
await registerUser(
b.email,
b.password,
b.name,
b.phone
);

return send(
res,
result.success?
201:
400,
result
);

}


/*
LOGIN
*/

if(
req.method==="POST"&&
path==="/api/auth/login"
){
const rl=rateLimit(req,"login",10,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=
await body(req);

const result=
await loginUser(
b.email,
b.password
);

return send(
res,
result.success?
200:
401,
result
);

}


/*
LOGOUT
*/

if(
req.method==="POST"&&
path==="/api/auth/logout"
){

const result=
await logoutUser(req);

return send(
res,
200,
result
);

}

return null;

}


async function handleExtraUserRoutes(req,res,path,url){
const user=await userFromToken(req);
if(!user) return null;
if(req.method==="GET"&&path==="/api/security"){
const security=await getSecurity(user.user_id); return send(res,200,{success:true,transactionPinSet:Boolean(security?.transaction_pin_hash)});
}
if(req.method==="POST"&&path==="/api/security/transaction-pin"){
const b=await body(req); const result=await setTransactionPin(user.user_id,b.pin,b.currentPin||""); return send(res,result.success?200:400,result);
}
if(req.method==="GET"&&path==="/api/transactions/detail"){
const ref=clean(url.searchParams.get("reference")); const r=await db(`SELECT * FROM transactions WHERE user_id=$1 AND reference=$2 LIMIT 1`,[user.user_id,ref]); if(!r.rows.length)return send(res,404,{success:false,message:"Transaction not found."}); const t=r.rows[0]; return send(res,200,{success:true,transaction:{...t,amount:Number(t.amount)}});
}
if(req.method==="GET"&&path==="/api/notifications"){
const r=await db(`SELECT id,title,message,type,read,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[user.user_id]);
const unread=r.rows.filter(n=>!n.read).length;
return send(res,200,{success:true,notifications:r.rows,unreadCount:unread});
}
if(req.method==="POST"&&path==="/api/notifications/read"){
const b=await body(req); if(b.id) await db(`UPDATE notifications SET read=TRUE WHERE id=$1 AND user_id=$2`,[b.id,user.user_id]); else await db(`UPDATE notifications SET read=TRUE WHERE user_id=$1`,[user.user_id]); return send(res,200,{success:true});
}
if(req.method==="POST"&&path==="/api/profile/update"){
const b=await body(req); const name=clean(b.name),phone=clean(b.phone),email=clean(b.email).toLowerCase();
if(name.length<2)return send(res,400,{success:false,message:"Please enter your full name."});
if(phone && !/^[0-9+()\-\s]{10,20}$/.test(phone))return send(res,400,{success:false,message:"Please enter a valid phone number."});
if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{success:false,message:"Please enter a valid email address."});
try{
const r=await db(`UPDATE users SET name=$1,phone=$2,email=$3,updated_at=NOW() WHERE user_id=$4 RETURNING user_id,name,phone,email,status,created_at`,[name,phone,email,user.user_id]);
if(!r.rows.length)return send(res,404,{success:false,message:"User account not found."});
return send(res,200,{success:true,user:r.rows[0],message:"Profile updated successfully."});
}catch(e){if(e.code==="23505")return send(res,409,{success:false,message:"That email address is already in use."}); throw e;}
}
if(req.method==="POST"&&path==="/api/support/tickets"){
const b=await body(req); const subject=clean(b.subject),message=clean(b.message); if(subject.length<3||message.length<5)return send(res,400,{success:false,message:"Please provide a subject and more details."});
const client=await pool.connect();
try{
await client.query("BEGIN");
const r=await client.query(`INSERT INTO support_tickets(user_id,subject,message) VALUES($1,$2,$3) RETURNING id,subject,message,status,created_at`,[user.user_id,subject,message]);
await client.query(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'user',$2,$3)`,[r.rows[0].id,user.user_id,message]);
await client.query("COMMIT");
return send(res,201,{success:true,ticket:r.rows[0],message:`Support ticket #${r.rows[0].id} created.`});
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}
if(req.method==="GET"&&path==="/api/support/tickets"){
const r=await db(`SELECT id,subject,message,status,created_at,updated_at FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,[user.user_id]); return send(res,200,{success:true,tickets:r.rows});
}
if(req.method==="GET"&&path==="/api/support/ticket"){
const id=Number(url.searchParams.get("id")); if(!Number.isInteger(id)||id<1)return send(res,400,{success:false,message:"Invalid ticket."});
const t=await db(`SELECT id,subject,message,status,created_at,updated_at FROM support_tickets WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,user.user_id]);
if(!t.rows.length)return send(res,404,{success:false,message:"Support ticket not found."});
const m=await db(`SELECT id,sender_type,message,created_at FROM support_messages WHERE ticket_id=$1 ORDER BY created_at ASC`,[id]);
return send(res,200,{success:true,ticket:t.rows[0],messages:m.rows});
}
if(req.method==="POST"&&path==="/api/support/ticket/reply"){
const b=await body(req); const id=Number(b.id),message=clean(b.message);
if(!Number.isInteger(id)||id<1||message.length<2)return send(res,400,{success:false,message:"Please enter a message."});
const t=await db(`SELECT id,status FROM support_tickets WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,user.user_id]);
if(!t.rows.length)return send(res,404,{success:false,message:"Support ticket not found."});
if(t.rows[0].status==="closed")return send(res,400,{success:false,message:"This ticket is closed. Please create a new ticket."});
await db(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'user',$2,$3)`,[id,user.user_id,message]);
await db(`UPDATE support_tickets SET status='open',updated_at=NOW() WHERE id=$1`,[id]);
return send(res,200,{success:true,message:"Reply sent."});
}
return null;
}

async function handleUserRoutes(
req,
res,
path,
url
){

/*
CURRENT USER
*/

if(
req.method==="GET"&&
path==="/api/me"
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
user:{
id:user.user_id,
userId:user.user_id,
name:user.name||"",
phone:user.phone||"",
email:user.email
}
});

}


/*
WALLET
*/

if(req.method==="POST"&&path==="/api/wallet/create"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
await createWallet(user.user_id);
const wallet=await getWallet(user.user_id);
return send(res,200,{success:true,wallet});
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


/*
TRANSACTIONS
*/

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


/*
PAYMENT INITIALIZATION
*/

if(
req.method==="POST"&&
path==="/api/payments/initialize"
){

const rl=rateLimit(req,"payment-initialize",10,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const b=
await body(req);

const amount=
Number(b.amount);

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
result.success?
200:
400,
result
);

}


/*
PAYMENT VERIFICATION
*/

if(
req.method==="GET"&&
path==="/api/payments/verify"
){

const rl=rateLimit(req,"payment-verify",20,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);

const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});

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
referenceValue,user.user_id
);

return send(
res,
result.success?
200:
400,
result
);

}


/*
VTU TRANSACTION
*/

if(
req.method==="POST"&&
["/api/vtu/purchase","/api/vtu/airtime","/api/vtu/data","/api/vtu/cable","/api/vtu/electricity"].includes(path)
){

const rl=rateLimit(req,"vtu-transaction",30,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);

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
if(!b.service){b.service=path.split("/").pop();}
if(!b.providerPayload){b.providerPayload={...b,service:b.service};}
const result=await processVTUTransaction(user,b);

return send(
res,
result.success?
200:
(result.statusCode||400),
result
);

}

return null;

  }
const server=http.createServer(
async(req,res)=>{

if(req.method==="OPTIONS"){

res.writeHead(204,{
"Access-Control-Allow-Origin":corsOrigin(req),
"Vary":"Origin",
"Access-Control-Allow-Methods":
"GET,POST,OPTIONS",
"Access-Control-Allow-Headers":
"Content-Type,Authorization,X-Idempotency-Key"
});

return res.end();

}

try{

res.__corsOrigin=corsOrigin(req);

const url=
new URL(
req.url,
`http://${req.headers.host||"localhost"}`
);

const path=
url.pathname;


/*
HEALTH CHECK
*/

if(
req.method==="GET"&&
path==="/"
){

return send(res,200,{
success:true,
message:
"BOLTIV API is running.",
status:
"online"
});

}


/*
API HEALTH CHECK
*/

if(
req.method==="GET"&&
path==="/api/health"
){
let database="not_configured";
if(DATABASE_URL){
try{
await db("SELECT 1");
database="connected";
}catch(error){
database="unavailable";
}
}
const ready=database==="connected";
return send(res,ready?200:503,{
success:ready,
message:ready?"BOLTIV API is healthy.":"BOLTIV API is not ready.",
status:ready?"online":"degraded",
database,
configuration:{
paystack:Boolean(PAYSTACK_SECRET_KEY),
vtu:Boolean(VTU_API_URL&&VTU_API_KEY),
mail:Boolean(RESEND_API_KEY)
},
timestamp:new Date().toISOString()
});

}


/*
ADMIN ROUTES
*/

const adminHandled=
await handleAdminRoutes(
req,
res,
path
);

if(adminHandled){

return;
}


/*
PASSWORD RESET ROUTES
*/

const passwordHandled=
await handlePasswordRoutes(
req,
res,
path
);

if(passwordHandled){

return;
}


/*
PUBLIC PLATFORM CONFIGURATION
*/
if(req.method==='GET'&&path==='/api/services'){const r=await db(`SELECT key,name,icon,enabled,fee,maintenance,config FROM services ORDER BY key`);return send(res,200,{success:true,services:r.rows});}
if(req.method==='GET'&&path==='/api/platform/settings'){return send(res,200,{success:true,settings:{maintenance_mode:Boolean(await getPlatformSetting('maintenance_mode',false)),registration_enabled:Boolean(await getPlatformSetting('registration_enabled',true))}});}

/*
AUTH ROUTES
*/

const authHandled=
await handleAuthRoutes(
req,
res,
path
);

if(authHandled){

return;
}


/*
USER ROUTES
*/

const extraHandled=await handleExtraUserRoutes(req,res,path,url);

if(extraHandled){return;}

const userHandled=
await handleUserRoutes(
req,
res,
path,
url
);

if(userHandled){

return;
}


/*
PAYSTACK WEBHOOK
*/

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

/*
Read the raw body because Paystack
signatures must be calculated from
the exact request body.
*/

let rawBody="";

req.on(
"data",
chunk=>{
rawBody+=chunk;
}
);

req.on(
"end",
async()=>{

try{

const signature=
req.headers["x-paystack-signature"];

if(!signature){

return send(res,401,{
success:false,
message:
"Missing Paystack signature."
});

}

const expectedSignature=
crypto
.createHmac(
"sha512",
PAYSTACK_SECRET_KEY
)
.update(rawBody)
.digest("hex");

const received=
String(signature);

if(
received.length!==
expectedSignature.length
){

return send(res,401,{
success:false,
message:
"Invalid Paystack signature."
});

}

const validSignature=
crypto.timingSafeEqual(
Buffer.from(received),
Buffer.from(expectedSignature)
);

if(!validSignature){

return send(res,401,{
success:false,
message:
"Invalid Paystack signature."
});

}

let event;

try{

event=
JSON.parse(rawBody);

}catch(error){

return send(res,400,{
success:false,
message:
"Invalid webhook payload."
});

}

if(
event.event!==
"charge.success"
){

return send(res,200,{
success:true,
message:
"Webhook received."
});

}

const transaction=
event.data||{};

const referenceValue=
clean(
transaction.reference
);

if(!referenceValue){

return send(res,400,{
success:false,
message:
"Payment reference is missing."
});

}

const paymentResult=
await db(
`SELECT *
FROM payments
WHERE reference=$1
LIMIT 1`,
[
referenceValue
]
);

if(!paymentResult.rows.length){

return send(res,404,{
success:false,
message:
"Payment record not found."
});

}

const payment=
paymentResult.rows[0];

if(payment.credited){

return send(res,200,{
success:true,
message:
"Payment already credited."
});

}

if(
Number(transaction.amount)!==
Number(payment.amount_kobo)
){

await db(
`UPDATE payments
SET status='failed'
WHERE reference=$1`,
[
referenceValue
]
);

return send(res,400,{
success:false,
message:
"Payment amount does not match."
});

}

const client=
await pool.connect();

try{

await client.query(
"BEGIN"
);

const lockedResult=
await client.query(
`SELECT *
FROM payments
WHERE reference=$1
FOR UPDATE`,
[
referenceValue
]
);

if(!lockedResult.rows.length){

await client.query(
"ROLLBACK"
);

return send(res,404,{
success:false,
message:
"Payment record not found."
});

}

const lockedPayment=
lockedResult.rows[0];

if(lockedPayment.credited){

await client.query(
"COMMIT"
);

return send(res,200,{
success:true,
message:
"Payment already credited."
});

}

if(String(lockedPayment.recipient_type||'user')==='admin'){
const balance=await creditAdminFromPayment(client,lockedPayment);
await client.query("COMMIT");
return send(res,200,{success:true,message:"Admin wallet funded.",reference:referenceValue,balance});
}

await client.query(
`INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[
lockedPayment.user_id
]
);

const walletResult=
await client.query(
`UPDATE wallets
SET
balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2
RETURNING balance`,
[
Number(lockedPayment.amount),
lockedPayment.user_id
]
);

if(!walletResult.rows.length){

throw new Error(
"Wallet update failed."
);

}

await client.query(
`UPDATE payments
SET
status='success',
credited=TRUE,
credited_at=NOW()
WHERE reference=$1`,
[
referenceValue
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
lockedPayment.user_id,
Number(lockedPayment.amount),
referenceValue
]
);

await client.query(
"COMMIT"
);

return send(res,200,{
success:true,
message:
"Payment received and wallet credited.",
reference:
referenceValue,
amount:
Number(lockedPayment.amount),
balance:
Number(
walletResult.rows[0].balance
)
});

}catch(error){

await client.query(
"ROLLBACK"
);

console.error(
"PAYSTACK WEBHOOK CREDIT ERROR:",
error
);

return send(res,500,{
success:false,
message:
"Unable to credit payment."
});

}finally{

client.release();

}

}catch(error){

console.error(
"PAYSTACK WEBHOOK ERROR:",
error
);

return send(res,500,{
success:false,
message:
"Webhook processing failed."
});

}

});

return;

}


/*
UNKNOWN ROUTE
*/

return send(res,404,{
success:false,
message:
"Route not found."
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
async function startServer(){

try{

await setup();

await cleanupPasswordResetTokens();

/*
Clean expired reset tokens every hour.
*/

setInterval(
()=>{
cleanupPasswordResetTokens();
},
60*60*1000
);

server.listen(
PORT,
"0.0.0.0",
()=>{

console.log(
`BOLTIV API running on port ${PORT}`
);

console.log(
`Frontend: ${FRONTEND_URL}`
);

console.log(
`Admin configured: ${
ADMIN_EMAIL?
"YES":
"NO"
}`
);

console.log(
`Paystack configured: ${
PAYSTACK_SECRET_KEY?
"YES":
"NO"
}`
);

console.log(
`VTU configured: ${
VTU_API_URL&&VTU_API_KEY?
"YES":
"NO"
}`
);

console.log(
`Password reset email configured: ${
RESEND_API_KEY?
"YES":
"NO"
}`
);

}
);

}catch(error){

console.error(
"STARTUP ERROR:",
error
);

process.exit(1);

}

}


process.on(
"SIGTERM",
async()=>{

console.log(
"SIGTERM received. Shutting down..."
);

server.close(
async()=>{

try{

await pool.end();

console.log(
"BOLTIV server stopped."
);

process.exit(0);

}catch(error){

console.error(
"SHUTDOWN ERROR:",
error
);

process.exit(1);

}

}
);

});


process.on(
"SIGINT",
async()=>{

console.log(
"SIGINT received. Shutting down..."
);

server.close(
async()=>{

try{

await pool.end();

console.log(
"BOLTIV server stopped."
);

process.exit(0);

}catch(error){

console.error(
"SHUTDOWN ERROR:",
error
);

process.exit(1);

}

}
);

});


startServer();

