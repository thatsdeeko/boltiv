const http=require("node:http");
const crypto=require("node:crypto");
const {Pool}=require("pg");

const PORT=process.env.PORT||3000;
const DATABASE_URL=process.env.DATABASE_URL||"";
const PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"";
const FLW_SECRET_KEY=process.env.FLW_SECRET_KEY||"";
const FLW_BASE_URL=(process.env.FLW_BASE_URL||"https://api.flutterwave.com/v3").replace(/\/+$/,"");
const FLW_CALLBACK_URL=process.env.FLW_CALLBACK_URL||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://boltiv.ng";

const ADMIN_EMAIL=process.env.ADMIN_EMAIL||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

const VTU_API_BASE_URL=process.env.VTU_API_BASE_URL||process.env.VTU_API_URL||"https://api.vtugate.com";
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
if(FRONTEND_URL.startsWith("https://"))res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
res.writeHead(status,{
"Content-Type":"application/json",
"Access-Control-Allow-Origin":res.__corsOrigin||DEFAULT_FRONTEND_ORIGIN,
"Vary":"Origin",
"Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS",
"Access-Control-Allow-Headers":"Content-Type,Authorization,X-Idempotency-Key,X-Admin-CSRF",
"Access-Control-Allow-Credentials":"true",
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
await db(`CREATE TABLE IF NOT EXISTS admin_profit_withdrawals(
id BIGSERIAL PRIMARY KEY,
admin_id BIGINT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
bank_code TEXT NOT NULL,
account_number TEXT NOT NULL,
account_name TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'pending',
reference TEXT UNIQUE NOT NULL,
provider_transfer_id TEXT,
provider_reference TEXT,
provider_message TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
completed_at TIMESTAMPTZ
)`);
await db(`CREATE INDEX IF NOT EXISTS admin_profit_withdrawals_admin_idx ON admin_profit_withdrawals(admin_id,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS admin_revenue_wallets(admin_id BIGINT PRIMARY KEY,balance NUMERIC(14,2) NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS admin_revenue_ledger(id BIGSERIAL PRIMARY KEY,admin_id BIGINT NOT NULL,type TEXT NOT NULL,amount NUMERIC(14,2) NOT NULL,balance_after NUMERIC(14,2) NOT NULL,reference TEXT UNIQUE NOT NULL,description TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS admin_revenue_ledger_admin_idx ON admin_revenue_ledger(admin_id,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS admin_revenue_withdrawals(id BIGSERIAL PRIMARY KEY,admin_id BIGINT NOT NULL,amount NUMERIC(14,2) NOT NULL,bank_code TEXT NOT NULL,account_number TEXT NOT NULL,account_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reference TEXT UNIQUE NOT NULL,recipient_code TEXT,provider_transfer_id TEXT,provider_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
await db(`CREATE INDEX IF NOT EXISTS admin_revenue_withdrawals_admin_idx ON admin_revenue_withdrawals(admin_id,created_at DESC)`);
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
for(const [key,name,icon] of [['airtime','Airtime','📱'],['data','Data','🌐'],['electricity','Electricity','💡'],['cable','Cable TV','📺']]) await db(`INSERT INTO services(key,name,icon) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`,[key,name,icon]);
await db(`DELETE FROM services WHERE key IN ('education','betting','sms','recharge_pin')`);
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

// Create an authenticated session immediately after registration so the
// new user can set the mandatory Transaction PIN before entering BOLTIV.
const sessionToken=token();
await db(
`INSERT INTO user_sessions(token,user_id,expires_at)
VALUES($1,$2,NOW()+INTERVAL '30 days')`,
[sessionToken,user.id]
);

return{
success:true,
message:
"Account created successfully. Please create your Transaction PIN.",
token:sessionToken,
transactionPinSet:false,
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
const csrfToken=token();

await recordSecurityEvent('admin_login_success','info',{email:admin.email},req,admin.id);

await db(
`INSERT INTO admin_sessions(
token,
admin_id,
expires_at,
csrf_token
)
VALUES(
$1,
$2,
NOW()+INTERVAL '24 hours',
$3
)`,
[
sessionToken,
admin.id,
csrfToken
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



function getAdminSessionToken(req){
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)boltiv_admin_session=([^;]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
  }
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function setAdminSessionCookie(res, token){
  const parts = [
    `boltiv_admin_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    "Max-Age=86400"
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminSessionCookie(res){
  const parts = [
    "boltiv_admin_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    "Max-Age=0"
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function adminFromToken(req){

const sessionToken=getAdminSessionToken(req);
if(!sessionToken)return null;

const result=await db(
`SELECT a.id,a.email
 FROM admin_sessions s
 JOIN admins a ON a.id=s.admin_id
 WHERE s.token=$1 AND s.expires_at>NOW()`,
[sessionToken]
);

return result.rows[0]||null;

}

async function logoutAdmin(req){

const sessionToken=getAdminSessionToken(req);
if(sessionToken){
await db(`DELETE FROM admin_sessions WHERE token=$1`,[sessionToken]);
}

return{
success:true,
message:"Admin logged out successfully."
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
  const result=await db(`UPDATE transactions SET status=$1,provider_reference=$2,completed_at=CASE WHEN $1='successful' THEN NOW() ELSE completed_at END,metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE reference=$4 AND status IN ('processing','pending') RETURNING *`,[status,extractVTUProviderReference(providerData),JSON.stringify(meta),referenceValue]);
  const tx=result.rows[0]||null;
  if(tx && status==='successful'){
    const credited=await creditAdminRevenueFromSale(Number(tx.amount),referenceValue,`Customer payment received for ${tx.service||'VTU service'}`);
    if(!credited)console.error('REVENUE LEDGER CREDIT FAILED FOR TRANSACTION',referenceValue);
  }
  return tx;
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

function vtuProviderName(){
  return String(process.env.VTU_PROVIDER||"vtugate").trim().toLowerCase();
}
function providerForService(service){
  const key=serviceKey(service);
  return vtuProviderName();
}

function vtugateEndpoint(service){
  const base=String(process.env.VTU_API_BASE_URL||process.env.VTU_API_URL||"https://api.vtugate.com").replace(/\/+$/,'');
  const cleanBase=base.replace(/\/api\/v1$/i,'');
  const map={
    airtime:"/api/v1/buyairtime",
    data:"/api/v1/buydata",
    cable:"/api/v1/buycabletv",
    electricity:"/api/v1/buyelectricity",
  };
  return cleanBase+(map[service]||"");
}

const VTUGATE_SERVICE_CACHE=new Map();
const VTUGATE_SERVICE_CACHE_TTL_MS=5*60*1000;

async function fetchVTUGateServices(serviceType){
  const now=Date.now();
  const cached=VTUGATE_SERVICE_CACHE.get(serviceType);
  if(cached && now-cached.time < VTUGATE_SERVICE_CACHE_TTL_MS) return cached.data;
  const base=String(process.env.VTU_API_BASE_URL||process.env.VTU_API_URL||"https://api.vtugate.com").replace(/\/+$/,'').replace(/\/api\/v1$/i,'');
  const url=base+'/api/v1/fetchservices';
  const response=await fetch(url,{
    method:'POST',
    headers:{
      'Authorization':`Bearer ${VTU_API_KEY}`,
      'Accept':'application/json',
      'Content-Type':'application/x-www-form-urlencoded'
    },
    body:new URLSearchParams({service_type:serviceType}).toString()
  });
  let data={};
  try{data=await response.json();}catch{data={};}
  if(!response.ok || data?.status!==true){
    console.error('VTUGATE SERVICE LOOKUP RESPONSE:',JSON.stringify({serviceType,statusCode:response.status,data}));
    throw new Error(data?.message||`VTUGATE service lookup failed (${response.status})`);
  }
  const services=Array.isArray(data.data)?data.data:[];
  VTUGATE_SERVICE_CACHE.set(serviceType,{time:now,data:services});
  return services;
}

async function resolveVTUGateServiceId(serviceType,network){
  const explicit=String(process.env[`VTU_${String(serviceType).toUpperCase()}_SERVICE_ID`]||'').trim();
  if(explicit) return explicit;
  const services=await fetchVTUGateServices(serviceType);
  const wanted=String(network||'').trim().toLowerCase();
  const match=services.find(item=>String(item?.network_name||item?.network||'').trim().toLowerCase()===wanted);
  if(!match?.service_id){
    throw new Error(`No VTUGATE ${serviceType} service is available for ${network||'the selected network'}.`);
  }
  return String(match.service_id);
}

const VTUGATE_DATA_PLAN_CACHE=new Map();
const VTUGATE_DATA_PLAN_CACHE_TTL_MS=30*1000;
// Plans that VTUGATE has explicitly rejected are temporarily hidden from customers.
// This prevents a stale/unavailable bundle from repeatedly appearing in the catalog.
const VTUGATE_UNAVAILABLE_DATA_PLAN_CACHE=new Map();
const VTUGATE_UNAVAILABLE_DATA_PLAN_TTL_MS=15*60*1000;
function dataPlanKey(network,serviceId,code){return `${String(network||'').trim().toLowerCase()}:${String(serviceId||'').trim()}:${String(code||'').trim()}`;}
function markVTUGateDataPlanUnavailable(network,serviceId,code){
  const key=dataPlanKey(network,serviceId,code);
  if(!key.endsWith(':'))VTUGATE_UNAVAILABLE_DATA_PLAN_CACHE.set(key,Date.now());
  VTUGATE_DATA_PLAN_CACHE.delete(String(network||'').trim().toLowerCase());
}
function isVTUGateDataPlanUnavailable(network,serviceId,code){
  const key=dataPlanKey(network,serviceId,code);
  const at=VTUGATE_UNAVAILABLE_DATA_PLAN_CACHE.get(key);
  if(!at)return false;
  if(Date.now()-at>=VTUGATE_UNAVAILABLE_DATA_PLAN_TTL_MS){VTUGATE_UNAVAILABLE_DATA_PLAN_CACHE.delete(key);return false;}
  return true;
}

async function fetchVTUGateDataPlans(network){
  const wanted=String(network||'').trim().toLowerCase();
  if(!wanted) throw new Error('Network is required.');
  const now=Date.now();
  const cached=VTUGATE_DATA_PLAN_CACHE.get(wanted);
  if(cached && now-cached.time < VTUGATE_DATA_PLAN_CACHE_TTL_MS) return cached.data;

  const services=await fetchVTUGateServices('data');
  const matching=services.filter(item=>
    String(item?.network_name||item?.network||'').trim().toLowerCase()===wanted && item?.service_id!==undefined
  );
  if(!matching.length) throw new Error(`No VTUGATE data service is available for ${network}.`);

  const base=String(process.env.VTU_API_BASE_URL||process.env.VTU_API_URL||'https://api.vtugate.com').replace(/\/+$/,'').replace(/\/api\/v1$/i,'');
  const url=base+'/api/v1/fetchdataplans';
  const merged=new Map();

  for(const service of matching){
    const serviceId=String(service.service_id);
    try{
      const response=await fetch(url,{
        method:'POST',
        headers:{
          'Authorization':`Bearer ${VTU_API_KEY}`,
          'Accept':'application/json',
          'Content-Type':'application/x-www-form-urlencoded'
        },
        body:new URLSearchParams({service_id:serviceId}).toString()
      });
      let data={};
      try{data=await response.json();}catch{data={};}
      if(!response.ok || data?.status!==true){
        console.error('VTUGATE DATA PLANS RESPONSE:',JSON.stringify({serviceId,statusCode:response.status,data}));
        continue;
      }
      const plans=Array.isArray(data?.data?.data_plans)?data.data.data_plans:[];
      for(const plan of plans){
        const code=String(plan?.code||plan?.plan_code||'').trim();
        if(!code) continue;
        const row={...plan,code,plan_code:code,service_id:Number(plan?.service_id||serviceId)};
        if(isVTUGateDataPlanUnavailable(wanted,row.service_id,code)) continue;
        const key=`${row.service_id}:${code}`;
        if(!merged.has(key)) merged.set(key,row);
      }
    }catch(error){
      console.error('VTUGATE DATA PLANS REQUEST ERROR:',JSON.stringify({serviceId,message:error?.message||'request failed'}));
    }
  }

  const plans=Array.from(merged.values()).sort((a,b)=>Number(a.price||0)-Number(b.price||0));
  VTUGATE_DATA_PLAN_CACHE.set(wanted,{time:now,data:plans});
  return plans;
}

async function buildVTUGateForm(payload){
  const p=payload&&typeof payload==='object'?payload:{};
  const service=serviceKey(p.service||"");
  const form=new URLSearchParams();
  const put=(key,value)=>{if(value!==undefined&&value!==null&&String(value)!=="")form.set(key,String(value));};
  if(service==='airtime'){
    const phone=String(p.phone||p.recipient||'').trim();
    const serviceId=String(p.service_id||await resolveVTUGateServiceId('airtime',p.network)).trim();
    put('service_id',serviceId);
    put('network',p.network);
    put('phone',phone);
    put('phone_number',phone);
    put('network_provider',p.network);
    put('amount',p.amount);
  }else if(service==='data'){
    const phone=String(p.phone||p.recipient||'').trim();
    const planCode=String(p.plan_code||p.planCode||p.plan||'').trim();
    const serviceId=String(p.service_id||'').trim();
    if(!serviceId || !planCode){
      throw new Error('Data service_id and plan_code are required.');
    }
    put('service_id',serviceId);
    put('plan_code',planCode);
    put('phone',phone);
    put('phone_number',phone);
    put('network',p.network);
    put('amount',p.amount);
  }else if(service==='cable'){
    put('provider',p.provider);
    put('smartcard',p.smartcard||p.iuc||p.iucNumber);
    put('plan',p.plan);
    put('amount',p.amount);
  }else if(service==='electricity'){
    put('provider',p.provider);
    put('meter_number',p.meterNumber||p.meter_number);
    put('meter_type',p.meterType||p.meter_type);
    put('amount',p.amount);
  }else{
    for(const [k,v] of Object.entries(p)){if(!['service','providerPayload'].includes(k)&&typeof v!=='object')put(k,v);}
  }
  return form;
}

function extractVTUProviderReference(providerData){
  const candidates=[
    providerData?.reference,
    providerData?.transaction_id,
    providerData?.transactionId,
    providerData?.transactionID,
    providerData?.id,
    providerData?.order_id,
    providerData?.job_id,
    providerData?.request_id,
    providerData?.data?.order_id,
    providerData?.data?.job_id,
    providerData?.data?.request_id,
    providerData?.data?.reference,
    providerData?.data?.transaction_id,
    providerData?.data?.transactionId,
    providerData?.data?.transactionID,
    providerData?.data?.id,
    providerData?.data?.data?.reference,
    providerData?.data?.data?.transaction_id,
    providerData?.data?.data?.transactionId,
    providerData?.data?.data?.transactionID,
    providerData?.data?.data?.id,
    providerData?.result?.reference,
    providerData?.result?.transaction_id,
    providerData?.result?.transactionId,
    providerData?.result?.id,
    providerData?.transaction?.reference,
    providerData?.transaction?.transaction_id,
    providerData?.transaction?.transactionId,
    providerData?.transaction?.id
  ];
  const value=candidates.find(v=>v!==undefined&&v!==null&&String(v).trim()!=="");
  return value===undefined?null:String(value).trim();
}

function extractVTUProviderMessage(providerData){
  const candidates=[
    providerData?.message,
    providerData?.error,
    providerData?.error_message,
    providerData?.provider_message,
    providerData?.detail,
    providerData?.description,
    providerData?.errors?.message,
    providerData?.errors?.error,
    providerData?.data?.message,
    providerData?.data?.error,
    providerData?.data?.error_message,
    providerData?.data?.provider_message,
    providerData?.data?.detail,
    providerData?.data?.description,
    providerData?.data?.errors?.message,
    providerData?.data?.errors?.error,
    providerData?.data?.data?.message,
    providerData?.data?.data?.error,
    providerData?.data?.data?.error_message,
    providerData?.data?.data?.provider_message,
    providerData?.data?.data?.detail,
    providerData?.result?.message,
    providerData?.result?.error,
    providerData?.result?.error_message
  ];
  for(const value of candidates){
    if(Array.isArray(value)){
      const text=value.map(v=>typeof v==='string'?v:(v?.message||v?.error||v?.detail||'')).filter(Boolean).join('; ');
      if(text)return text;
    }else if(value&&typeof value==='object'){
      const text=value.message||value.error||value.detail;
      if(text)return String(text);
    }else if(value!==undefined&&value!==null&&String(value).trim()!==''){
      return String(value).trim();
    }
  }
  return '';
}

function isVTUGateBundleUnavailable(providerData){
  const text=extractVTUProviderMessage(providerData).toLowerCase();
  return /cannot purchase|not available|unavailable|not currently|at the moment|explore other.*plans/.test(text);
}

async function findVTUGateDataFallback(originalPayload,providerData){
  try{
    const network=clean(originalPayload?.network).toUpperCase();
    const currentCode=clean(originalPayload?.plan_code||originalPayload?.planCode||originalPayload?.plan);
    const currentServiceId=Number(originalPayload?.service_id||0);
    const amount=Number(originalPayload?.amount||0);
    if(!network||!currentCode||!amount)return null;

    // Force a fresh catalog after a provider-side bundle rejection.
    VTUGATE_DATA_PLAN_CACHE.delete(network.toLowerCase());
    const plans=await fetchVTUGateDataPlans(network);
    if(!Array.isArray(plans)||!plans.length)return null;

    // The original plan has just been rejected by VTUGATE, so immediately remove it from the customer catalog.
    markVTUGateDataPlanUnavailable(network,currentServiceId,currentCode);
    const currentPlan=plans.find(plan=>String(plan.code||plan.plan_code||'')===currentCode && Number(plan.service_id||0)===currentServiceId);
    const targetSize=Number(currentPlan?.size_mb||providerData?.data?.size_mb||0);
    const targetValidity=Number(currentPlan?.validity_days||providerData?.data?.validity_days||0);
    const targetName=clean(currentPlan?.name||'').toLowerCase();

    const candidates=plans.filter(plan=>{
      const code=clean(plan.code||plan.plan_code);
      const serviceId=Number(plan.service_id||0);
      const price=Number(plan.price||0);
      if(!code||!serviceId||code===currentCode&&serviceId===currentServiceId)return false;
      if(!Number.isFinite(price)||price<=0||price>amount)return false;
      const size=Number(plan.size_mb||0), validity=Number(plan.validity_days||0);
      if(targetSize>0 && size!==targetSize)return false;
      if(targetValidity>0 && validity!==targetValidity)return false;
      const name=clean(plan.name||'').toLowerCase();
      // Prefer the same named bundle when the catalog provides multiple providers.
      if(targetName && name && name!==targetName && targetSize===0)return false;
      return true;
    });
    candidates.sort((a,b)=>{
      const ar=a.delivery_rate===null||a.delivery_rate===undefined?-1:Number(a.delivery_rate);
      const br=b.delivery_rate===null||b.delivery_rate===undefined?-1:Number(b.delivery_rate);
      return br-ar || Number(a.price||0)-Number(b.price||0);
    });
    const fallback=candidates[0];
    if(!fallback)return null;
    return {
      ...originalPayload,
      plan_code:clean(fallback.code||fallback.plan_code),
      service_id:Number(fallback.service_id),
      amount:Number(fallback.price||amount)
    };
  }catch(error){
    console.error('VTUGATE DATA FALLBACK LOOKUP ERROR:',error?.message||error);
    return null;
  }
}

async function callVTUProvider(payload){
  const service=serviceKey(payload?.service||"");
  const provider=providerForService(service);

  if(!VTU_API_KEY){
    return{success:false,configured:false,message:"VTU provider is not configured."};
  }
  const url=provider==='vtugate'?vtugateEndpoint(service):String(VTU_API_BASE_URL||"").replace(/\/+$/,'');
  if(!url){return{success:false,configured:false,message:"VTU provider URL is not configured."};}
  try{
    const isVTUGate=provider==='vtugate';
    const form=isVTUGate?await buildVTUGateForm(payload):null;
    const requestHeaders={"Authorization":`Bearer ${VTU_API_KEY}`,"Accept":"application/json"};
    let response;
    if(isVTUGate){
      response=await fetch(url,{method:"POST",headers:{...requestHeaders,"Content-Type":"application/x-www-form-urlencoded"},body:form.toString()});
      let firstData={};try{firstData=await response.json();}catch{firstData={};}
      const providerOk=typeof firstData?.status==='boolean'?firstData.status:response.ok;
      if(!response.ok||!providerOk) console.error("VTU PROVIDER RESPONSE:",JSON.stringify({provider,service,statusCode:response.status,data:firstData}));
      return{success:Boolean(response.ok&&providerOk),configured:true,statusCode:response.status,data:firstData};
    }
    response=await fetch(url,{method:"POST",headers:{...requestHeaders,"Content-Type":"application/json"},body:JSON.stringify(payload||{})});
    let data={};try{data=await response.json();}catch{data={};}
    const providerOk=typeof data?.status==='boolean'?data.status:response.ok;
    if(!response.ok||!providerOk) console.error("VTU PROVIDER RESPONSE:",JSON.stringify({provider,service,statusCode:response.status,data}));
    return{success:Boolean(response.ok&&providerOk),configured:true,statusCode:response.status,data};
  }catch(error){
    console.error("VTU PROVIDER REQUEST ERROR:",error);
    return{success:false,configured:true,statusCode:502,data:{},error:true,message:"VTU provider request failed."};
  }
}


function pricingConfig(service){
  const cfg=service?.config&&typeof service.config==='object'?service.config:{};
  const pricing=cfg.pricing&&typeof cfg.pricing==='object'?cfg.pricing:{};
  const legacyMode=String(pricing.mode||'discount').toLowerCase();
  const markupMode=String(pricing.markup_mode||'fixed').toLowerCase();
  const markupPct=Number(pricing.markup_pct||0);
  const markupFixed=Number(pricing.markup_fixed||0);
  const discount=Number(pricing.discount_pct||0);
  const fixedProfit=Number(pricing.fixed_profit||0);
  return {
    markup_mode:['fixed','percentage'].includes(markupMode)?markupMode:'fixed',
    markup_pct:Number.isFinite(markupPct)&&markupPct>=0?markupPct:0,
    markup_fixed:Number.isFinite(markupFixed)&&markupFixed>=0?markupFixed:0,
    // Legacy provider-discount fields retained for compatibility with old installs.
    mode:['discount','fixed'].includes(legacyMode)?legacyMode:'discount',
    discount_pct:Number.isFinite(discount)&&discount>=0?discount:0,
    fixed_profit:Number.isFinite(fixedProfit)&&fixedProfit>=0?fixedProfit:0
  };
}

function customerPriceFromCost(providerCost,rule){
  const cost=Number(providerCost);
  if(!Number.isFinite(cost)||cost<0) return null;
  let price=cost;
  if(rule.markup_mode==='percentage'&&rule.markup_pct>0) price=cost*(1+rule.markup_pct/100);
  else if(rule.markup_mode==='fixed'&&rule.markup_fixed>0) price=cost+rule.markup_fixed;
  return Number(price.toFixed(2));
}

function providerAmountFromCustomer(customerAmount,rule){
  const amount=Number(customerAmount);
  if(!Number.isFinite(amount)||amount<=0)return null;
  if(rule.markup_mode==='percentage'&&rule.markup_pct>0) return Number((amount/(1+rule.markup_pct/100)).toFixed(2));
  if(rule.markup_mode==='fixed'&&rule.markup_fixed>0) return Number(Math.max(0,amount-rule.markup_fixed).toFixed(2));
  return Number(amount.toFixed(2));
}

function providerCostFromResponse(providerData,fallbackAmount){
  const candidates=[providerData?.data?.amount_charged,providerData?.data?.data?.amount_charged,providerData?.amount_charged,providerData?.data?.amount,providerData?.data?.data?.amount,providerData?.amount,providerData?.data?.provider_amount,providerData?.provider_amount,providerData?.data?.cost,providerData?.cost];
  for(const value of candidates){const n=Number(value);if(Number.isFinite(n)&&n>0)return Number(n.toFixed(2));}
  return null;
}

function estimatedProviderCost(service,customerAmount){
  const rule=pricingConfig(service);
  const amount=Number(customerAmount);
  const cost=providerAmountFromCustomer(amount,rule);
  return {cost:cost===null?amount:cost,source:(rule.markup_mode==='percentage'&&rule.markup_pct>0)?'markup_pct':(rule.markup_mode==='fixed'&&rule.markup_fixed>0?'markup_fixed':'no_markup'),rule};
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
let pricing=estimatedProviderCost(service,amount);
let pricingCostOverride=null;
const providerPayload={...(data.providerPayload||data)};
// Airtime amount is the face value delivered to the customer; amount is the marked-up price charged to the wallet.
if(serviceKey(data.service)==='airtime'){
  const airtimeValue=Number(providerPayload.airtime_amount||data.airtime_amount||0);
  if(!Number.isFinite(airtimeValue)||airtimeValue<50) return {success:false,statusCode:400,message:'A valid airtime amount is required.'};
  const expectedCustomer=customerPriceFromCost(airtimeValue,pricingConfig(service));
  if(expectedCustomer===null||Math.abs(amount-expectedCustomer)>0.01) return {success:false,statusCode:400,message:'Airtime price has changed. Please refresh and try again.'};
  pricingCostOverride=Number(airtimeValue.toFixed(2));
  pricing={...estimatedProviderCost(service,amount),cost:pricingCostOverride,source:'airtime_face_value'};
}
// For data, verify the exact live plan so customers cannot alter the wholesale amount in the browser.
if(serviceKey(data.service)==='data') {
  const network=clean(providerPayload.network||data.network).toUpperCase();
  const code=clean(providerPayload.plan_code||providerPayload.planCode||providerPayload.plan);
  const serviceId=Number(providerPayload.service_id||data.service_id||0);
  if(!network||!code||!serviceId) return {success:false,statusCode:400,message:'A valid data plan is required.'};
  try {
    const livePlans=await fetchVTUGateDataPlans(network);
    const livePlan=livePlans.find(x=>String(x.code||x.plan_code||'')===code && Number(x.service_id||0)===serviceId);
    if(!livePlan) return {success:false,statusCode:400,message:'This data plan is no longer available. Please refresh and choose another plan.'};
    const wholesale=Number(livePlan.price);
    const expectedCustomer=customerPriceFromCost(wholesale,pricingConfig(service));
    if(!Number.isFinite(wholesale)||wholesale<=0||expectedCustomer===null) return {success:false,statusCode:400,message:'Unable to price this data plan.'};
    if(Math.abs(amount-expectedCustomer)>0.01) return {success:false,statusCode:400,message:'This data plan price has changed. Please refresh the plans and try again.'};
    pricingCostOverride=wholesale;
    pricing={...estimatedProviderCost(service,amount),cost:Number(wholesale.toFixed(2)),source:'live_data_plan'};
  } catch(error) {
    return {success:false,statusCode:502,message:error?.message||'Unable to verify the selected data plan.'};
  }
}
if(pricing.cost>amount+0.001){return {success:false,statusCode:400,message:"Service pricing would cost more than the customer price. Update the service pricing before enabling sales."};}
// The customer pays the marked-up price; the provider receives only the wholesale amount.
providerPayload.amount=pricingCostOverride===null?pricing.cost:pricingCostOverride;
const pinCheck=await requireTransactionPin(userId,data.transactionPin||"");
if(pinCheck.success){
  // Boltiv's transaction PIN is the PIN the user enters for this purchase.
  providerPayload.pin=data.transactionPin;
}
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
const safeTxMeta={...(data.metadata&&typeof data.metadata==='object'?data.metadata:{})};
const payloadPhone=clean(providerPayload.phone||providerPayload.phone_number||data.phone||data.recipient||'');
const payloadNetwork=clean(providerPayload.network||providerPayload.network_provider||data.network||'').toUpperCase();
const payloadProvider=clean(providerPayload.provider||data.provider||'');
const payloadPlan=clean(providerPayload.plan_code||providerPayload.planCode||providerPayload.plan||data.plan||'');
const payloadSmartcard=clean(providerPayload.smartcard||providerPayload.iuc||providerPayload.iucNumber||data.smartcard||data.iuc||'');
const payloadMeter=clean(providerPayload.meter_number||providerPayload.meterNumber||data.meter_number||data.meterNumber||'');
const payloadMeterType=clean(providerPayload.meter_type||providerPayload.meterType||data.meter_type||data.meterType||'');
if(payloadPhone)safeTxMeta.phone=payloadPhone;
if(payloadNetwork)safeTxMeta.network=payloadNetwork;
if(payloadProvider)safeTxMeta.provider=payloadProvider;
if(payloadPlan)safeTxMeta.plan=payloadPlan;
if(payloadSmartcard)safeTxMeta.smartcard=payloadSmartcard;
if(payloadMeter)safeTxMeta.meterNumber=payloadMeter;
if(payloadMeterType)safeTxMeta.meterType=payloadMeterType;
const txRecipient=clean(data.recipient||payloadPhone||payloadSmartcard||payloadMeter||'')||null;
await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,idempotency_key,recipient,metadata) VALUES($1,'debit',$2,$3,$4,'processing',NOW(),$5,$6,$7)`,[userId,data.service||"VTU Service",amount,referenceValue,idempotencyKey,txRecipient,Object.keys(safeTxMeta).length?JSON.stringify(safeTxMeta):null]);
await client.query("COMMIT");
}catch(error){try{await client.query("ROLLBACK");}catch{} client.release(); console.error("TRANSACTION RESERVE ERROR:",error); return {success:false,statusCode:500,message:"Unable to start transaction."};}
client.release();
let providerResult;
try{providerResult=await callVTUProvider(providerPayload);}catch(error){providerResult={success:false,configured:true,data:{},error:true};}
if(!providerResult.configured){const refundResult=await markTransactionFailedAndRefund(referenceValue,"provider_not_configured"); if(!refundResult.success) return {success:false,statusCode:500,message:refundResult.message,reference:referenceValue,status:"processing"};await addNotification(userId,"Transaction failed","Your BOLTIV transaction was refunded because the service provider is not configured yet.","error");return {success:false,statusCode:503,message:providerResult.message,reference:referenceValue,status:"failed",balance:(await getWallet(userId))?.balance||0};}
let providerData=providerResult.data||{};
const actualProviderCost=providerCostFromResponse(providerData,amount);
const providerCost=actualProviderCost===null?pricing.cost:actualProviderCost;
const pricingSource=actualProviderCost===null?pricing.source:'provider_response';
const grossProfit=Number((amount-providerCost).toFixed(2));
if(!providerResult.success && serviceKey(data.service)==='data' && vtuProviderName()==='vtugate' && isVTUGateBundleUnavailable(providerData)){
  const fallbackPayload=await findVTUGateDataFallback(data.providerPayload||data,providerData);
  if(fallbackPayload){
    console.warn('VTUGATE DATA BUNDLE REJECTED; RETRYING ALTERNATE LIVE PLAN:',JSON.stringify({network:fallbackPayload.network,service_id:fallbackPayload.service_id,plan_code:fallbackPayload.plan_code,amount:fallbackPayload.amount}));
    const retryResult=await callVTUProvider(fallbackPayload);
    if(retryResult.success){
      providerResult=retryResult;
      providerData=retryResult.data||{};
      data.providerPayload=fallbackPayload;
      const retryCost=providerCostFromResponse(providerData,Number(fallbackPayload.amount||pricing.cost));
      if(retryCost!==null){pricingCostOverride=retryCost;pricing={...pricing,cost:retryCost,source:'provider_response'};}
    }else if(isVTUGateBundleUnavailable(retryResult.data||{})){
      markVTUGateDataPlanUnavailable(fallbackPayload.network,fallbackPayload.service_id,fallbackPayload.plan_code);
    }
  }
}
const finalProviderCost=providerCostFromResponse(providerData,pricing.cost);
const finalCost=finalProviderCost===null?pricing.cost:finalProviderCost;
const finalGrossProfit=Number((amount-finalCost).toFixed(2));
if(!providerResult.success){
const refundResult=await markTransactionFailedAndRefund(referenceValue,"provider_failed",providerData); if(!refundResult.success) return {success:false,statusCode:500,message:refundResult.message,reference:referenceValue,status:"processing"};
const providerMessage=extractVTUProviderMessage(providerData);
const providerCode=providerResult.provider_code||providerData?.code||providerData?.error_code||providerData?.data?.code||providerData?.data?.error_code||null;
const providerStatus=providerResult.provider_status||providerData?.status||providerData?.data?.status||null;
const providerHttpStatus=providerResult.statusCode||null;
const fallbackMessage=`${data.service||"Service"} transaction failed. Your wallet has been refunded.`;
await addNotification(userId,"Transaction failed",`${data.service||"Service"} failed and your wallet was refunded. Reference: ${referenceValue}${providerMessage?` Provider: ${providerMessage}`:''}`,"error");
return {
  success:false,
  statusCode:providerHttpStatus && providerHttpStatus>=400 && providerHttpStatus<600 ? providerHttpStatus : 400,
  message:providerMessage||providerResult.message||fallbackMessage,
  provider_message:providerMessage||providerResult.message||null,
  provider_code:providerCode,
  provider_status:providerStatus,
  provider_http_status:providerHttpStatus,
  provider_reference:extractVTUProviderReference(providerData),
  reference:referenceValue,
  status:"failed",
  balance:(await getWallet(userId))?.balance||0
};
}
const providerStatusRaw=String(providerData.status||providerData.data?.status||providerData.data?.order_status||providerData.data?.data?.status||"").toLowerCase();
const providerMessage=String(providerData.message||providerData.data?.message||providerData.data?.provider_message||"").toLowerCase();
const providerStatus=providerStatusRaw||(/processing|queued|initiated|pending|on-hold/.test(providerMessage)?"processing":/failed|cancelled|refunded/.test(providerMessage)?"failed":"successful");
const pending=["pending","processing","queued","in_progress","initiated","processing-api","queued-api","pending-api","on-hold"].includes(providerStatus);
const finalStatus=pending?"pending":"successful";
const finalized=await finalizeVTUTransaction(referenceValue,providerData,pending,{customerAmount:amount,providerCost:finalCost,grossProfit:finalGrossProfit,pricingSource,pricingRule:pricing.rule}); if(!finalized) return {success:false,statusCode:409,message:"Transaction state changed while processing. Check transaction history.",reference:referenceValue,status:"processing"};
await addNotification(userId,pending?"Transaction processing":"Transaction successful",pending?`${data.service||"Service"} is still processing. Reference: ${referenceValue}`:`${data.service||"Service"} was completed successfully. Reference: ${referenceValue}`,pending?"pending":"success");
const finalWallet=await getWallet(userId);
const responseMeta={};
const responsePhone=clean(providerPayload.phone||providerPayload.phone_number||data.phone||data.recipient||'');
const responseNetwork=clean(providerPayload.network||providerPayload.network_provider||data.network||'').toUpperCase();
const responseProvider=clean(providerPayload.provider||data.provider||'');
const responsePlan=clean(providerPayload.plan_code||providerPayload.planCode||providerPayload.plan||data.plan||'');
if(responsePhone)responseMeta.phone=responsePhone;
if(responseNetwork)responseMeta.network=responseNetwork;
if(responseProvider)responseMeta.provider=responseProvider;
if(responsePlan)responseMeta.plan=responsePlan;
return {success:true,message:pending?`${data.service} is being processed.`:`${data.service} purchase successful.`,reference:referenceValue,amount,status:finalStatus,balance:finalWallet?.balance||0,phone:responsePhone||null,network:responseNetwork||null,provider:responseProvider||null,plan:responsePlan||null,data:providerData,transaction:{reference:referenceValue,service:data.service,amount,phone:responsePhone||null,network:responseNetwork||null,provider:responseProvider||null,plan:responsePlan||null,metadata:responseMeta}};
}


async function requeryVTUGateTransaction(referenceValue){
  if(vtuProviderName()!=="vtugate") return {success:false,configured:false,message:"Automatic requery is currently configured for VTUGATE only."};
  if(!VTU_API_KEY) return {success:false,configured:false,message:"VTU provider is not configured."};
  const base=String(process.env.VTU_API_BASE_URL||process.env.VTU_API_URL||"https://api.vtugate.com").replace(/\/+$/,'').replace(/\/api\/v1$/i,'');
  const url=base+"/api/v1/transactionstatus";
  try{
    const response=await fetch(url,{
      method:"POST",
      headers:{Authorization:`Bearer ${VTU_API_KEY}`,Accept:"application/json","Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({reference:String(referenceValue),request_id:String(referenceValue)}).toString()
    });
    let data={}; try{data=await response.json();}catch{}
    return {success:response.ok,configured:true,statusCode:response.status,data};
  }catch(error){
    return {success:false,configured:true,error:true,message:error?.message||"Unable to requery VTUGATE."};
  }
}

function normalizeRequeryStatus(data){
  const raw=data?.status??data?.data?.status??data?.data?.transaction?.status??data?.transaction?.status??data?.result?.status??"";
  const status=String(raw||"").trim().toLowerCase();
  if(["successful","success","completed","complete","delivered","successful_delivery"].includes(status)) return "successful";
  if(["failed","failure","reversed","refunded","cancelled","canceled"].includes(status)) return "failed";
  return "pending";
}

async function reconcilePendingTransactions(admin=null,req=null){
  const r=await db(`SELECT id,user_id,service,amount,reference,status,provider_reference,date FROM transactions WHERE type='debit' AND status IN ('processing','pending') ORDER BY date ASC LIMIT 100`);
  const results=[];
  for(const t of r.rows){
    const q=await requeryVTUGateTransaction(t.reference);
    if(!q.configured || !q.success){
      results.push({...t,amount:Number(t.amount),requery_status:"unavailable",message:q.message||"Provider status could not be checked."});
      continue;
    }
    const status=normalizeRequeryStatus(q.data);
    if(status==="successful"){
      const finalized=await finalizeVTUTransaction(t.reference,q.data,false,{reconciled:true,requeryResponse:q.data});
      if(finalized){
        await addNotification(t.user_id,"Transaction successful",`${t.service||"Service"} was confirmed successful. Reference: ${t.reference}`,"success");
        results.push({...t,amount:Number(t.amount),requery_status:"successful",resolved:true});
      }else results.push({...t,amount:Number(t.amount),requery_status:"successful",resolved:false});
    }else if(status==="failed"){
      const refund=await markTransactionFailedAndRefund(t.reference,"provider_requery_failed",q.data);
      if(refund.success){
        await addNotification(t.user_id,"Transaction refunded",`${t.service||"Service"} failed and your wallet was refunded. Reference: ${t.reference}`,"error");
        results.push({...t,amount:Number(t.amount),requery_status:"failed",refunded:true,refundReference:refund.refundReference||null});
      }else results.push({...t,amount:Number(t.amount),requery_status:"failed",refunded:false,message:refund.message});
    }else{
      results.push({...t,amount:Number(t.amount),requery_status:"pending",resolved:false});
    }
  }
  return {success:true,count:r.rows.length,resolved:results.filter(x=>x.resolved||x.refunded).length,transactions:results};
}

async function getPlatformSetting(key,fallback=null){const r=await db(`SELECT value FROM platform_settings WHERE key=$1`,[key]);return r.rows.length?r.rows[0].value:fallback;}
async function setPlatformSetting(key,value){await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[key,JSON.stringify(value)]);}
function serviceKey(value){const v=clean(value).toLowerCase();return ({airtime:'airtime',data:'data',electricity:'electricity',cable:'cable','cable tv':'cable'})[v]||v;}
async function getService(key){const r=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services WHERE key=$1`,[serviceKey(key)]);return r.rows[0]||null;}
async function recordSecurityEvent(eventType,severity,details={},req=null,adminId=null){await db(`INSERT INTO security_events(admin_id,event_type,severity,details,ip) VALUES($1,$2,$3,$4::jsonb,$5)`,[adminId,eventType,severity,JSON.stringify(details),req?requestIp(req):null]);}

async function adminServices(req,action){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};if(action==='list'){const r=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services ORDER BY key`);return{success:true,services:r.rows};}const b=await body(req);const key=serviceKey(b.key||b.service);const existing=await getService(key);if(!existing)return{success:false,statusCode:404,message:'Service not found.'};const enabled=b.enabled===undefined?existing.enabled:Boolean(b.enabled);const maintenance=b.maintenance===undefined?existing.maintenance:Boolean(b.maintenance);const fee=b.fee===undefined?Number(existing.fee||0):Number(b.fee);if(!Number.isFinite(fee)||fee<0)return{success:false,statusCode:400,message:'Invalid service fee.'};const incomingConfig=b.config===undefined?{}:(b.config||{});const oldConfig=existing.config&&typeof existing.config==='object'?existing.config:{};const config={...oldConfig,...incomingConfig,pricing:{...(oldConfig.pricing||{}),...(incomingConfig.pricing||{})}};if(config.pricing){const mode=String(config.pricing.mode||'discount').toLowerCase();const discount=Number(config.pricing.discount_pct||0);const fixedProfit=Number(config.pricing.fixed_profit||0);const markupMode=String(config.pricing.markup_mode||'fixed').toLowerCase();const markupPct=Number(config.pricing.markup_pct||0);const markupFixed=Number(config.pricing.markup_fixed||0);if(!['discount','fixed'].includes(mode)||!Number.isFinite(discount)||discount<0||discount>100||!Number.isFinite(fixedProfit)||fixedProfit<0||!['fixed','percentage'].includes(markupMode)||!Number.isFinite(markupPct)||markupPct<0||markupPct>100||!Number.isFinite(markupFixed)||markupFixed<0)return{success:false,statusCode:400,message:'Invalid pricing configuration.'};config.pricing={...config.pricing,mode,discount_pct:discount,fixed_profit:fixedProfit,markup_mode:markupMode,markup_pct:markupPct,markup_fixed:markupFixed};}const r=await db(`UPDATE services SET enabled=$1,maintenance=$2,fee=$3,config=$4::jsonb,updated_at=NOW() WHERE key=$5 RETURNING key,name,icon,enabled,fee,maintenance,config,updated_at`,[enabled,maintenance,fee,JSON.stringify(config),key]);await adminAudit(admin,'service_updated','service',key,{enabled,maintenance,fee,config},req);return{success:true,service:r.rows[0]};}
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
async function ensureAdminRevenueWallet(client,adminId){await client.query(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);}
async function addAdminRevenueLedger(client,adminId,type,amount,balanceAfter,description,reference){await client.query(`INSERT INTO admin_revenue_ledger(admin_id,type,amount,balance_after,reference,description) VALUES($1,$2,$3,$4,$5,$6)`,[adminId,type,amount,balanceAfter,reference,description]);}
async function primaryAdminId(){const r=await db(`SELECT id FROM admins ORDER BY id ASC LIMIT 1`);return r.rows[0]?.id||null;}
async function creditAdminRevenueFromSale(customerAmount,transactionReference,description='Customer service sale'){
  const amount=Number(customerAmount); if(!Number.isFinite(amount)||amount<=0)return false;
  const adminId=await primaryAdminId(); if(!adminId){console.error('ADMIN REVENUE CREDIT: no admin exists');return false;}
  const c=await pool.connect();
  try{await c.query('BEGIN');await ensureAdminRevenueWallet(c,adminId);
    const ref=`SALE-${transactionReference}`;
    const existing=await c.query(`SELECT id FROM admin_revenue_ledger WHERE reference=$1 LIMIT 1`,[ref]);
    if(existing.rows.length){await c.query('COMMIT');return true;}
    const r=await c.query(`UPDATE admin_revenue_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[amount,adminId]);
    if(!r.rows.length)throw new Error('Revenue wallet update failed.');
    const balanceAfter=Number(r.rows[0].balance);
    await addAdminRevenueLedger(c,adminId,'sale',amount,balanceAfter,description,ref);
    await c.query('COMMIT');return true;
  }catch(e){try{await c.query('ROLLBACK')}catch{};console.error('ADMIN REVENUE CREDIT ERROR:',e);return false;}finally{c.release();}
}

async function creditAdminFromPayment(client,payment){await ensureAdminWallet(client,payment.admin_id);const wr=await client.query(`UPDATE admin_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(payment.amount),payment.admin_id]);if(!wr.rows.length)throw new Error('Admin wallet update failed.');const balanceAfter=Number(wr.rows[0].balance);await addAdminLedger(client,payment.admin_id,'funding',Number(payment.amount),balanceAfter,'Paystack admin wallet funding',`AF-${payment.reference}`);await client.query(`UPDATE payments SET status='success',credited=TRUE,credited_at=NOW() WHERE reference=$1`,[payment.reference]);return balanceAfter;}

async function flutterwaveRequest(path, options={}){
  if(!FLW_SECRET_KEY) return {success:false,statusCode:503,message:"Flutterwave payouts are not configured."};
  try{
    const response=await fetch(`${FLW_BASE_URL}${path}`,{
      ...options,
      headers:{Authorization:`Bearer ${FLW_SECRET_KEY}`,"Content-Type":"application/json",...(options.headers||{})}
    });
    let data={}; try{data=await response.json();}catch{}
    return {success:Boolean(response.ok && data?.status!=="error"),statusCode:response.status,data};
  }catch(error){
    console.error("FLUTTERWAVE REQUEST ERROR:",error.message);
    return {success:false,statusCode:502,message:"Unable to connect to Flutterwave."};
  }
}
async function adminProfitSummary(adminId){
  const p=await db(`SELECT COALESCE(SUM(CASE WHEN type='debit' AND status='successful' THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit FROM transactions`);
  const w=await db(`SELECT COALESCE(SUM(CASE WHEN status IN ('pending','processing','successful') THEN amount ELSE 0 END),0) AS reserved FROM admin_profit_withdrawals WHERE admin_id=$1`,[adminId]);
  const grossProfit=Number(p.rows[0]?.gross_profit||0), reserved=Number(w.rows[0]?.reserved||0);
  return {grossProfit,reserved,available:Math.max(0,Number((grossProfit-reserved).toFixed(2)))};
}
async function flutterwaveBanks(){
  const r=await flutterwaveRequest("/banks?country=NG");
  if(!r.success)return{success:false,statusCode:r.statusCode||502,message:r.data?.message||r.message||"Unable to load Nigerian banks."};
  return{success:true,banks:Array.isArray(r.data?.data)?r.data.data:[]};
}
async function resolveFlutterwaveAccount(bankCode,accountNumber){
  const r=await flutterwaveRequest("/accounts/resolve",{method:"POST",body:JSON.stringify({account_bank:String(bankCode),account_number:String(accountNumber)})});
  const name=r.data?.data?.account_name;
  if(!r.success||!name)return{success:false,statusCode:r.statusCode||400,message:r.data?.message||"Unable to verify the bank account."};
  return{success:true,accountName:String(name).trim(),accountNumber:r.data.data.account_number||String(accountNumber)};
}
async function paystackRequest(path,options={}){
  if(!PAYSTACK_SECRET_KEY)return{success:false,statusCode:503,message:'Paystack is not configured.'};
  try{
    const response=await fetch(`${PAYSTACK_API_URL}${path}`,{...options,headers:{'Authorization':`Bearer ${PAYSTACK_SECRET_KEY}`,'Content-Type':'application/json',...(options.headers||{})}});
    let data={};try{data=await response.json()}catch{}
    return{success:Boolean(response.ok&&data?.status),statusCode:response.status,data};
  }catch(e){return{success:false,statusCode:502,message:'Unable to connect to Paystack.'};}
}
async function adminRevenue(req,action){
  const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};
  if(action==='summary'){
    await db(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
    const w=(await db(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1`,[admin.id])).rows[0];
    const r=(await db(`SELECT COALESCE(SUM(CASE WHEN type='sale' THEN amount ELSE 0 END),0) AS sales,COALESCE(SUM(CASE WHEN type='refund' THEN ABS(amount) ELSE 0 END),0) AS refunds FROM admin_revenue_ledger WHERE admin_id=$1`,[admin.id])).rows[0];
    const gross=(await db(`SELECT COALESCE(SUM(CASE WHEN type='debit' AND status='successful' THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit FROM transactions`)).rows[0];
    const reserved=(await db(`SELECT COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount ELSE 0 END),0) AS reserved FROM admin_revenue_withdrawals WHERE admin_id=$1`,[admin.id])).rows[0];
    const balance=Number(w?.balance||0),hold=Number(reserved?.reserved||0);
    const rows=await db(`SELECT id,amount,bank_code,account_number,account_name,status,reference,provider_transfer_id,provider_message,created_at,updated_at,completed_at FROM admin_revenue_withdrawals WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 100`,[admin.id]);
    return{success:true,summary:{balance,sales:Number(r?.sales||0),refunds:Number(r?.refunds||0),grossProfit:Number(gross?.gross_profit||0),reserved:hold,available:Math.max(0,Number((balance-hold).toFixed(2)))},withdrawals:rows.rows.map(x=>({...x,amount:Number(x.amount||0)}))};
  }
  if(action==='banks'){const r=await paystackRequest('/bank?country=nigeria&perPage=100');if(!r.success)return{success:false,statusCode:r.statusCode||502,message:r.data?.message||'Unable to load banks.'};return{success:true,banks:Array.isArray(r.data?.data)?r.data.data:[]};}
  if(action==='verify'){
    const b=await body(req),bankCode=clean(b.bankCode||b.bank_code),accountNumber=clean(b.accountNumber||b.account_number);
    if(!bankCode||!/^[0-9]{10}$/.test(accountNumber))return{success:false,statusCode:400,message:'Enter a valid Nigerian bank code and 10-digit account number.'};
    const r=await paystackRequest(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    const name=r.data?.data?.account_name;if(!r.success||!name)return{success:false,statusCode:r.statusCode||400,message:r.data?.message||'Unable to verify the bank account.'};
    return{success:true,accountName:String(name).trim(),accountNumber:r.data.data.account_number||accountNumber};
  }
  if(action==='status'){
    const b=await body(req),id=Number(b.id||0);if(!id)return{success:false,statusCode:400,message:'Withdrawal ID is required.'};
    const row=(await db(`SELECT * FROM admin_revenue_withdrawals WHERE id=$1 AND admin_id=$2 LIMIT 1`,[id,admin.id])).rows[0];if(!row)return{success:false,statusCode:404,message:'Withdrawal not found.'};
    if(!row.reference||['successful','failed'].includes(String(row.status)))return{success:true,withdrawal:{...row,amount:Number(row.amount)}};
    const r=await paystackRequest(`/transfer/verify/${encodeURIComponent(row.reference)}`);
    if(!r.success)return{success:false,statusCode:r.statusCode||502,message:r.data?.message||'Unable to check transfer status.'};
    const ps=String(r.data?.data?.status||'').toLowerCase();let ns=row.status;
    if(['success','successful','completed'].includes(ps))ns='successful';else if(['failed','reversed'].includes(ps))ns='failed';else ns='processing';
    if(ns!==row.status){
      const c=await pool.connect();try{await c.query('BEGIN');
        await c.query(`UPDATE admin_revenue_withdrawals SET status=$1,provider_transfer_id=$2,provider_message=$3,updated_at=NOW(),completed_at=CASE WHEN $1 IN ('successful','failed') THEN NOW() ELSE completed_at END WHERE id=$4`,[ns,r.data?.data?.id||null,r.data?.message||ps,row.id]);
        if(ns==='failed'){await ensureAdminRevenueWallet(c,admin.id);const w=await c.query(`UPDATE admin_revenue_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(row.amount),admin.id]);if(w.rows.length)await addAdminRevenueLedger(c,admin.id,'withdrawal_reversal',Number(row.amount),Number(w.rows[0].balance),'Failed withdrawal reversal',`REVERSAL-${row.reference}`);}
        await c.query('COMMIT');
      }catch(e){try{await c.query('ROLLBACK')}catch{};return{success:false,statusCode:500,message:'Unable to update withdrawal status.'};}finally{c.release();}
    }
    const fresh=(await db(`SELECT * FROM admin_revenue_withdrawals WHERE id=$1`,[row.id])).rows[0];return{success:true,withdrawal:{...fresh,amount:Number(fresh.amount)}};
  }
  if(action==='withdraw'){
    const b=await body(req),amount=Number(b.amount),bankCode=clean(b.bankCode||b.bank_code),accountNumber=clean(b.accountNumber||b.account_number);
    if(!Number.isFinite(amount)||amount<1000)return{success:false,statusCode:400,message:'Minimum withdrawal is ₦1,000.'};
    if(!bankCode||!/^[0-9]{10}$/.test(accountNumber))return{success:false,statusCode:400,message:'Enter a valid Nigerian bank account.'};
    const verifyResult=await paystackRequest(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);const verifiedName=verifyResult.data?.data?.account_name;const verified={success:Boolean(verifyResult.success&&verifiedName),accountName:verifiedName?String(verifiedName).trim():'',accountNumber:verifyResult.data?.data?.account_number||accountNumber};if(!verified.success)return{success:false,statusCode:verifyResult.statusCode||400,message:verifyResult.data?.message||'Unable to verify the bank account.'};
    const client=await pool.connect();let row;
    try{await client.query('BEGIN');await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`boltiv-revenue-withdraw:${admin.id}`]);await ensureAdminRevenueWallet(client,admin.id);
      const w=await client.query(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1 FOR UPDATE`,[admin.id]);const balance=Number(w.rows[0]?.balance||0);
      const reserved=(await client.query(`SELECT COALESCE(SUM(amount),0) AS reserved FROM admin_revenue_withdrawals WHERE admin_id=$1 AND status IN ('pending','processing')`,[admin.id])).rows[0];const available=Math.max(0,Number((balance-Number(reserved?.reserved||0)).toFixed(2)));
      if(amount>available){await client.query('ROLLBACK');return{success:false,statusCode:400,message:`Insufficient BOLTIV balance. Available: ₦${available.toLocaleString('en-NG',{minimumFractionDigits:2})}.`};}
      const ref=reference('BOLTIV-WD').toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,50);
      const br=await client.query(`UPDATE admin_revenue_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[amount,admin.id]);
      row=(await client.query(`INSERT INTO admin_revenue_withdrawals(admin_id,amount,bank_code,account_number,account_name,status,reference) VALUES($1,$2,$3,$4,$5,'processing',$6) RETURNING *`,[admin.id,amount,bankCode,verified.accountNumber,verified.accountName,ref])).rows[0];
      await addAdminRevenueLedger(client,admin.id,'withdrawal',-amount,Number(br.rows[0].balance),'Admin bank withdrawal',`WD-${ref}`);
      await client.query('COMMIT');
    }catch(e){try{await client.query('ROLLBACK')}catch{};return{success:false,statusCode:500,message:'Unable to reserve BOLTIV balance for withdrawal.'};}finally{client.release();}
    const recipient=await paystackRequest('/transferrecipient',{method:'POST',body:JSON.stringify({type:'nuban',name:verified.accountName,account_number:verified.accountNumber,bank_code:bankCode,currency:'NGN'})});
    if(!recipient.success){await reverseRevenueWithdrawal(admin.id,row.id,row.amount,'Recipient creation failed');return{success:false,statusCode:400,message:recipient.data?.message||'Unable to create transfer recipient.',withdrawalId:row.id};}
    const recipientCode=recipient.data?.data?.recipient_code;
    if(!recipientCode){await reverseRevenueWithdrawal(admin.id,row.id,row.amount,'Paystack did not return a recipient code');return{success:false,statusCode:502,message:'Unable to create a valid transfer recipient.',withdrawalId:row.id};}
    const tr=await paystackRequest('/transfer',{method:'POST',body:JSON.stringify({source:'balance',amount:Math.round(amount*100),recipient:recipientCode,reference:row.reference,reason:'BOLTIV withdrawal',currency:'NGN'})});
    if(!tr.success){await reverseRevenueWithdrawal(admin.id,row.id,row.amount,tr.data?.message||'Transfer failed');return{success:false,statusCode:400,message:tr.data?.message||'Paystack transfer failed.',withdrawalId:row.id};}
    const ps=String(tr.data?.data?.status||'pending').toLowerCase();const status=['success','successful','completed'].includes(ps)?'successful':(['failed','reversed'].includes(ps)?'failed':'processing');
    await db(`UPDATE admin_revenue_withdrawals SET status=$1,recipient_code=$2,provider_transfer_id=$3,provider_message=$4,updated_at=NOW(),completed_at=CASE WHEN $1 IN ('successful','failed') THEN NOW() ELSE NULL END WHERE id=$5`,[status,recipientCode,tr.data?.data?.id||null,tr.data?.message||ps,row.id]);
    await adminAudit(admin,'revenue_withdrawal_created','revenue_withdrawal',String(row.id),{amount,bankCode,accountNumber:verified.accountNumber,accountName:verified.accountName,reference:row.reference,status},req);
    return{success:true,message:status==='successful'?'BOLTIV withdrawal completed.':'BOLTIV withdrawal submitted and is being processed.',withdrawalId:row.id,reference:row.reference,status,accountName:verified.accountName,amount};
  }
  return{success:false,statusCode:400,message:'Unknown revenue action.'};
}
async function reverseRevenueWithdrawal(adminId,id,amount,reason){const c=await pool.connect();try{await c.query('BEGIN');const row=(await c.query(`SELECT * FROM admin_revenue_withdrawals WHERE id=$1 AND admin_id=$2 FOR UPDATE`,[id,adminId])).rows[0];if(!row){await c.query('ROLLBACK');return;}if(row.status==='failed'){await c.query('COMMIT');return;}await ensureAdminRevenueWallet(c,adminId);const w=await c.query(`UPDATE admin_revenue_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(amount),adminId]);if(w.rows.length)await addAdminRevenueLedger(c,adminId,'withdrawal_reversal',Number(amount),Number(w.rows[0].balance),reason,`REVERSAL-${row.reference}`);await c.query(`UPDATE admin_revenue_withdrawals SET status='failed',provider_message=$1,updated_at=NOW(),completed_at=NOW() WHERE id=$2`,[reason,id]);await c.query('COMMIT');}catch(e){try{await c.query('ROLLBACK')}catch{};console.error('REVENUE WITHDRAWAL REVERSAL ERROR',e)}finally{c.release();}}

async function adminProfitWithdrawals(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="summary"){
    const summary=await adminProfitSummary(admin.id);
    const rows=await db(`SELECT id,amount,bank_code,account_number,account_name,status,reference,provider_transfer_id,provider_message,created_at,updated_at,completed_at FROM admin_profit_withdrawals WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 100`,[admin.id]);
    return{success:true,summary,withdrawals:rows.rows.map(x=>({...x,amount:Number(x.amount||0)}))};
  }
  if(action==="banks")return await flutterwaveBanks();
  if(action==="verify"){
    const b=await body(req),bankCode=clean(b.bankCode||b.account_bank),accountNumber=clean(b.accountNumber||b.account_number);
    if(!bankCode||!/^\d{10}$/.test(accountNumber))return{success:false,statusCode:400,message:"Enter a valid Nigerian bank code and 10-digit account number."};
    return await resolveFlutterwaveAccount(bankCode,accountNumber);
  }
  if(action==="status"){
    const b=await body(req),id=Number(b.id||0);
    if(!id)return{success:false,statusCode:400,message:"Withdrawal ID is required."};
    const row=(await db(`SELECT * FROM admin_profit_withdrawals WHERE id=$1 AND admin_id=$2 LIMIT 1`,[id,admin.id])).rows[0];
    if(!row)return{success:false,statusCode:404,message:"Withdrawal not found."};
    if(!row.provider_transfer_id||["successful","failed"].includes(String(row.status)))return{success:true,withdrawal:{...row,amount:Number(row.amount)}};
    const r=await flutterwaveRequest(`/transfers/${encodeURIComponent(row.provider_transfer_id)}`);
    if(!r.success)return{success:false,statusCode:r.statusCode||502,message:r.data?.message||r.message||"Unable to check transfer status."};
    const ps=String(r.data?.data?.status||r.data?.status||"").toUpperCase();
    let ns=row.status;
    if(["SUCCESSFUL","COMPLETED"].includes(ps))ns="successful";
    else if(["FAILED","REVERSED"].includes(ps))ns="failed";
    else if(["PROCESSING","NEW","PENDING","QUEUED"].includes(ps))ns="processing";
    if(ns!==row.status)await db(`UPDATE admin_profit_withdrawals SET status=$1,provider_message=$2,updated_at=NOW(),completed_at=CASE WHEN $1 IN ('successful','failed') THEN NOW() ELSE completed_at END WHERE id=$3`,[ns,r.data?.message||ps,row.id]);
    const fresh=(await db(`SELECT * FROM admin_profit_withdrawals WHERE id=$1`,[row.id])).rows[0];
    return{success:true,withdrawal:{...fresh,amount:Number(fresh.amount)}};
  }
  if(action==="create"){
    return{success:false,statusCode:410,message:"The old profit-only withdrawal route is disabled. Use the BOLTIV Revenue Wallet withdrawal."};
    const b=await body(req),amount=Number(b.amount),bankCode=clean(b.bankCode||b.account_bank),accountNumber=clean(b.accountNumber||b.account_number);
    if(!Number.isFinite(amount)||amount<=0)return{success:false,statusCode:400,message:"Enter a valid withdrawal amount."};
    if(amount<1000)return{success:false,statusCode:400,message:"Minimum profit withdrawal is ₦1,000."};
    if(!bankCode||!/^\d{10}$/.test(accountNumber))return{success:false,statusCode:400,message:"Enter a valid Nigerian bank account."};
    if(!FLW_SECRET_KEY)return{success:false,statusCode:503,message:"Flutterwave payout credentials are not configured on the backend."};
    const verified=await resolveFlutterwaveAccount(bankCode,accountNumber);
    if(!verified.success)return verified;
    const client=await pool.connect(); let row;
    try{
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`boltiv-profit-withdraw:${admin.id}`]);
      const p=await client.query(`SELECT COALESCE(SUM(CASE WHEN type='debit' AND status='successful' THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit FROM transactions`);
      const w=await client.query(`SELECT COALESCE(SUM(CASE WHEN status IN ('pending','processing','successful') THEN amount ELSE 0 END),0) AS reserved FROM admin_profit_withdrawals WHERE admin_id=$1`,[admin.id]);
      const available=Math.max(0,Number((Number(p.rows[0]?.gross_profit||0)-Number(w.rows[0]?.reserved||0)).toFixed(2)));
      if(amount>available){await client.query("ROLLBACK");return{success:false,statusCode:400,message:`Insufficient available profit. You can withdraw up to ₦${available.toLocaleString("en-NG",{minimumFractionDigits:2})}.`};}
      const ref=reference("BOLTIV-PROFIT");
      row=(await client.query(`INSERT INTO admin_profit_withdrawals(admin_id,amount,bank_code,account_number,account_name,status,reference) VALUES($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,[admin.id,amount,bankCode,verified.accountNumber,verified.accountName,ref])).rows[0];
      await client.query("COMMIT");
    }catch(error){
      try{await client.query("ROLLBACK")}catch{}
      console.error("PROFIT WITHDRAWAL RESERVE ERROR:",error);
      return{success:false,statusCode:500,message:"Unable to reserve profit for withdrawal."};
    }finally{client.release();}
    const payload={account_bank:bankCode,account_number:verified.accountNumber,amount,currency:"NGN",narration:"BOLTIV profit withdrawal",reference:row.reference,debit_currency:"NGN",...(FLW_CALLBACK_URL?{callback_url:FLW_CALLBACK_URL}:{})};
    const tr=await flutterwaveRequest("/transfers",{method:"POST",body:JSON.stringify(payload)});
    if(!tr.success){
      await db(`UPDATE admin_profit_withdrawals SET status='failed',provider_message=$1,updated_at=NOW(),completed_at=NOW() WHERE id=$2`,[tr.data?.message||tr.message||"Flutterwave transfer failed.",row.id]);
      await adminAudit(admin,'profit_withdrawal_failed','profit_withdrawal',String(row.id),{amount,reference:row.reference},req);
      return{success:false,statusCode:400,message:tr.data?.message||tr.message||"Flutterwave transfer failed.",withdrawalId:row.id};
    }
    const provider=tr.data?.data||{},ps=String(provider.status||"NEW").toUpperCase();
    const status=["SUCCESSFUL","COMPLETED"].includes(ps)?"successful":(["FAILED","REVERSED"].includes(ps)?"failed":"processing");
    await db(`UPDATE admin_profit_withdrawals SET status=$1,provider_transfer_id=$2,provider_reference=$3,provider_message=$4,updated_at=NOW(),completed_at=CASE WHEN $1 IN ('successful','failed') THEN NOW() ELSE NULL END WHERE id=$5`,[status,provider.id||null,provider.reference||null,tr.data?.message||ps,row.id]);
    await adminAudit(admin,'profit_withdrawal_created','profit_withdrawal',String(row.id),{amount,bankCode,accountNumber:verified.accountNumber,accountName:verified.accountName,reference:row.reference,status},req);
    return{success:true,message:status==="successful"?"Profit withdrawal completed.":"Profit withdrawal submitted and is being processed.",withdrawalId:row.id,reference:row.reference,status,accountName:verified.accountName,amount};
  }
  return{success:false,statusCode:400,message:"Unknown withdrawal action."};
}
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
await ensureAdminRevenueWallet(c,admin.id);
const rev=await c.query(`UPDATE admin_revenue_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[amount,admin.id]);
if(rev.rows.length){const revRef=`REF-SALE-${ref}`;await addAdminRevenueLedger(c,admin.id,'refund',-amount,Number(rev.rows[0].balance),`Refund for ${ref}`,revRef);}
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
const adminRevenueResult=await db(`SELECT COALESCE(SUM(balance),0) AS balance FROM admin_revenue_wallets`);

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
adminWalletBalance:Number(adminWalletResult.rows[0]?.balance||0),
adminRevenueBalance:Number(adminRevenueResult.rows[0]?.balance||0)
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
t.provider_reference,
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
providerCost:Number(item.metadata?.pricing?.providerCost||0),
provider_reference:item.provider_reference||extractVTUProviderReference(item.metadata?.providerResponse||item.metadata?.provider_response||item.metadata)||null
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


function secureTokenEquals(a,b){
const aa=Buffer.from(String(a||''));
const bb=Buffer.from(String(b||''));
return aa.length>0&&aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
}

async function adminCsrfToken(req){
const sessionToken=getAdminSessionToken(req);
if(!sessionToken)return null;
const r=await db(`SELECT csrf_token FROM admin_sessions WHERE token=$1 AND expires_at>NOW()`,[sessionToken]);
return r.rows[0]?.csrf_token||null;
}

async function requireAdminCsrf(req){
const expected=await adminCsrfToken(req);
const provided=String(req.headers['x-admin-csrf']||'');
if(!expected||!secureTokenEquals(provided,expected))return {success:false,statusCode:403,message:'CSRF validation failed.'};
return {success:true};
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

if(result.success&&result.token){
setAdminSessionCookie(res,result.token);
const safeResult={...result};
delete safeResult.token;
return send(res,200,safeResult);
}

return send(
res,
result.success?200:401,
result
);

}

if(req.method==="GET"&&path==="/api/admin/csrf"){
const admin=await adminFromToken(req);
if(!admin)return send(res,401,{success:false,message:"Unauthorized."});
const csrf=await adminCsrfToken(req);
return send(res,200,{success:true,csrfToken:csrf});
}

if(req.method!=="GET"&&req.method!=="HEAD"&&path!=="/api/admin/login"){
const csrfCheck=await requireAdminCsrf(req);
if(!csrfCheck.success)return send(res,csrfCheck.statusCode||403,csrfCheck);
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


if(req.method==="GET"&&path==="/api/admin/wallet"){const result=await adminWalletInfo(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==='GET'&&path==='/api/admin/revenue'){const result=await adminRevenue(req,'summary');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==='GET'&&path==='/api/admin/revenue/banks'){const result=await adminRevenue(req,'banks');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==='POST'&&path==='/api/admin/revenue/verify-account'){const result=await adminRevenue(req,'verify');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==='POST'&&path==='/api/admin/revenue/withdraw'){const result=await adminRevenue(req,'withdraw');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==='POST'&&path==='/api/admin/revenue/status'){const result=await adminRevenue(req,'status');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/profit"){const result=await adminProfitWithdrawals(req,"summary");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/profit/banks"){const result=await adminProfitWithdrawals(req,"banks");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/profit/verify-account"){const result=await adminProfitWithdrawals(req,"verify");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/profit/withdraw"){const result=await adminProfitWithdrawals(req,"create");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/profit/status"){const result=await adminProfitWithdrawals(req,"status");return send(res,result.success?200:(result.statusCode||400),result);}
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
clearAdminSessionCookie(res);

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
const rl=rateLimit(req,`transaction-pin-change:${user.user_id}`,5,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
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

await createWallet(user.user_id);
const wallet=await getWallet(user.user_id);

return send(res,200,{
success:true,
user:{
id:user.user_id,
userId:user.user_id,
name:user.name||"",
phone:user.phone||"",
email:user.email
},
wallet
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
VTU DATA PLAN CATALOG
*/

if(
req.method==="POST"&&
path==="/api/vtu/data/plans"
){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
const b=await body(req);
const network=clean(b.network).toUpperCase();
if(!network)return send(res,400,{success:false,message:"Network is required."});
try{
  const rawPlans=await fetchVTUGateDataPlans(network);
  const dataService=await getService('data');
  const dataPricing=pricingConfig(dataService);
  const byPlan=new Map();
  for(const plan of rawPlans){
    const code=clean(plan.code||plan.plan_code);
    if(!code)continue;
    if(isVTUGateDataPlanUnavailable(network,plan.service_id,code))continue;
    const size=Number(plan.size_mb||0);
    const validity=Number(plan.validity_days||0);
    const price=Number(plan.price||0);
    if(!Number.isFinite(price)||price<=0)continue;
    const customerPrice=customerPriceFromCost(price,dataPricing);
    if(customerPrice===null||customerPrice<=0)continue;
    const key=`${code}|${size}|${validity}`;
    const row={
      code,
      name:clean(plan.name||code),
      customer_price:customerPrice,
      network_name:clean(plan.network_name||network).toUpperCase(),
      service_id:Number(plan.service_id),
      size_mb:size,
      validity_days:validity,
      delivery_rate:plan.delivery_rate===null||plan.delivery_rate===undefined?null:Number(plan.delivery_rate),
      delivery_comment:clean(plan.delivery_comment||"")
    };
    const previous=byPlan.get(key);
    if(!previous||row.customer_price<previous.customer_price)byPlan.set(key,row);
  }
  const plans=Array.from(byPlan.values())
    .filter(plan=>plan && plan.delivery_rate!==null && plan.delivery_rate!==undefined && Number.isFinite(Number(plan.delivery_rate)) && Number(plan.delivery_rate)>=95)
    .sort((a,b)=>Number(b.delivery_rate)-Number(a.delivery_rate) || Number(a.customer_price)-Number(b.customer_price) || Number(a.size_mb)-Number(b.size_mb))
    .slice(0,13);
  return send(res,200,{success:true,network,plans});
}catch(error){
  console.error("VTU DATA PLAN CATALOG ERROR:",error);
  return send(res,502,{success:false,message:error?.message||"Unable to fetch data plans."});
}
}

/*
VTUGATE ELECTRICITY METER VERIFICATION
*/
if(req.method==="POST"&&path==="/api/vtu/electricity/verify"){
  const rl=rateLimit(req,"electricity-verify",30,60*1000);
  if(!rl.allowed)return rateLimitedResponse(res,rl);
  const user=await userFromToken(req);
  if(!user)return send(res,401,{success:false,message:"Unauthorized."});
  if(vtuProviderName()!=="vtugate")return send(res,503,{success:false,message:"VTUGATE electricity verification is not configured."});
  if(!VTU_API_KEY)return send(res,503,{success:false,message:"VTU provider is not configured."});
  try{
    const b=await body(req);
    const provider=String(b.provider||"").trim();
    const meterNumber=String(b.meterNumber||b.meter_number||"").trim();
    const meterType=String(b.meterType||b.meter_type||"Prepaid").trim();
    if(!provider||!meterNumber)return send(res,400,{success:false,message:"Provider and meter number are required."});
    const base=String(VTU_API_BASE_URL||"https://api.vtugate.com").replace(/\\+$/,'').replace(/\/api\/v1$/i,'');
    const url=base+"/api/v1/verifyelectricity";
    const form=new URLSearchParams({provider,meter_number:meterNumber,meter_type:meterType}).toString();
    const response=await fetch(url,{method:"POST",headers:{Authorization:`Bearer ${VTU_API_KEY}`,Accept:"application/json","Content-Type":"application/x-www-form-urlencoded"},body:form});
    let data={};try{data=await response.json();}catch{}
    console.log("VTUGATE ELECTRICITY VERIFY:",JSON.stringify({provider,meterNumber,meterType,statusCode:response.status,data}));
    if(!response.ok||data?.status!==true)return send(res,response.status>=400&&response.status<500?response.status:502,{success:false,message:data?.message||"Unable to verify electricity meter.",provider_data:data});
    return send(res,200,{success:true,message:data?.message||"Electricity meter verified successfully.",data:data?.data||data,provider_data:data});
  }catch(error){
    console.error("VTUGATE ELECTRICITY VERIFY ERROR:",error?.message||error);
    return send(res,502,{success:false,message:"Unable to verify electricity meter right now."});
  }
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
"GET,POST,PATCH,OPTIONS",
"Access-Control-Allow-Headers":
"Content-Type,Authorization,X-Idempotency-Key,X-Admin-CSRF",
"Access-Control-Allow-Credentials":"true"
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
vtu:Boolean(process.env.VTU_API_KEY&& (process.env.VTU_API_BASE_URL||process.env.VTU_API_URL)),
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
if(req.method==='GET'&&path==='/api/pricing'){
  const keys=['airtime','data','cable','electricity'];
  const out={};
  for(const key of keys){const svc=await getService(key);const p=pricingConfig(svc);out[key]={markup_mode:p.markup_mode,markup_pct:p.markup_pct,markup_fixed:p.markup_fixed};}
  return send(res,200,{success:true,pricing:out});
}

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

// Reconcile provider-pending transactions every 5 minutes.
setInterval(()=>{
  reconcilePendingTransactions().catch(error=>console.error("AUTOMATIC TRANSACTION RECONCILIATION ERROR:",error));
},5*60*1000).unref();

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
process.env.VTU_API_KEY&&(process.env.VTU_API_BASE_URL||process.env.VTU_API_URL)?
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

