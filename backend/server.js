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
const MAIL_FROM=process.env.MAIL_FROM||"BOLTIV <onboarding@resend.dev>";

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
`SELECT *
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

const user=
result.rows[0];

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
Do not expose the email-service failure
to the user as an account-discovery signal.
*/

console.error(
"PASSWORD RESET EMAIL FAILED:",
emailResult.message
);

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
password
){

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
referenceValue
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


async function refundWallet(
userId,
amount
){

if(!validAmount(amount)){

return{
success:false,
message:
"Invalid refund amount."
};

}

const result=
await db(
`UPDATE wallets
SET
balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2
RETURNING balance`,
[
Number(amount),
userId
]
);

if(!result.rows.length){

await createWallet(
userId
);

const retry=
await db(
`UPDATE wallets
SET
balance=balance+$1,
updated_at=NOW()
WHERE user_id=$2
RETURNING balance`,
[
Number(amount),
userId
]
);

if(!retry.rows.length){

return{
success:false,
message:
"Unable to refund wallet."
};

}

return{
success:true,
balance:
Number(
retry.rows[0].balance
)
};

}

return{
success:true,
balance:
Number(
result.rows[0].balance
)
};

}


async function insertTransaction({
userId,
service,
amount,
reference,
status,
type="debit"
}){

const result=
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
RETURNING *`,
[
userId,
type,
service,
Number(amount),
reference,
status
]
);

return result.rows[0];

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


async function processVTUTransaction(
user,
data
){

const userId=
user.user_id;

const amount=
Number(data.amount);

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

const current=
await getWallet(
userId
);

if(
!current||
current.balance<amount
){

return{
success:false,
statusCode:400,
message:
"Insufficient wallet balance.",
balance:
current?
current.balance:
0
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
finalWallet.balance:
0,
data:
providerData
};

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

return{
users:
Number(
usersResult.rows[0]?.count||0
),

walletBalance:
Number(
walletResult.rows[0]?.balance||0
),

transactions:
Number(
transactionsResult.rows[0]?.count||0
),

payments:
Number(
paymentsResult.rows[0]?.count||0
)
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
updated_at:user.updated_at
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
date:item.date
}));

}


async function adminPayments(){

const result=
await db(
`SELECT
p.id,
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
id:item.id,
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
b.password
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
path==="/api/vtu/purchase"
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

const b=
await body(req);

const result=
await processVTUTransaction(
user,
b
);

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
"Access-Control-Allow-Origin":"*",
"Access-Control-Allow-Methods":
"GET,POST,OPTIONS",
"Access-Control-Allow-Headers":
"Content-Type,Authorization"
});

return res.end();

}

try{

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

return send(res,200,{
success:true,
message:
"BOLTIV API is healthy.",
status:
"online",
timestamp:
new Date().toISOString()
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

