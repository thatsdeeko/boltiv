const http=require("node:http"),crypto=require("node:crypto"),{Pool}=require("pg");
const PORT=process.env.PORT||3000,DATABASE_URL=process.env.DATABASE_URL||"",PAYSTACK_SECRET_KEY=process.env.PAYSTACK_SECRET_KEY||"",FRONTEND_URL=process.env.FRONTEND_URL||"https://thatsdeeko.github.io/boltiv",ADMIN_EMAIL=process.env.ADMIN_EMAIL||"",ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const pool=new Pool({connectionString:DATABASE_URL,ssl:DATABASE_URL?{rejectUnauthorized:false}:false});
const db=(q,p=[])=>pool.query(q,p);
const send=(r,s,d)=>{r.writeHead(s,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"});r.end(JSON.stringify(d))};
const body=req=>new Promise((ok,no)=>{let b="";req.on("data",x=>b+=x);req.on("end",()=>{try{ok(b?JSON.parse(b):{})}catch(e){no(e)}});req.on("error",no)});
const token=()=>crypto.randomBytes(32).toString("hex"),ref=()=>`BOLTIV-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,uid=()=>`BOLTIV-${crypto.randomBytes(10).toString("hex")}`;
const hash=(p,s=crypto.randomBytes(16).toString("hex"))=>`${s}:${crypto.scryptSync(p,s,64).toString("hex")}`;
const verify=(p,x)=>{try{let[s,k]=x.split(":"),h=crypto.scryptSync(p,s,64).toString("hex");return crypto.timingSafeEqual(Buffer.from(h,"hex"),Buffer.from(k,"hex"))}catch{return false}};
const initials=n=>{let x=String(n||"").trim().split(/\s+/).filter(Boolean);return x.length>1?(x[0][0]+x.at(-1)[0]).toUpperCase():(x[0]?.[0]||"U").toUpperCase()};

async function init(){
if(!DATABASE_URL)return console.log("DATABASE_URL is not configured.");
await db(`CREATE TABLE IF NOT EXISTS users(id BIGSERIAL PRIMARY KEY,user_id TEXT UNIQUE NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,initials TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS password_resets(id BIGSERIAL PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,token TEXT UNIQUE NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used BOOLEAN DEFAULT FALSE,created_at TIMESTAMPTZ DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS user_sessions(token TEXT PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL)`);
await db(`CREATE TABLE IF NOT EXISTS wallets(user_id TEXT PRIMARY KEY,balance NUMERIC(14,2) DEFAULT 0,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS transactions(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL,service TEXT NOT NULL,amount NUMERIC(14,2) NOT NULL,reference TEXT UNIQUE,status TEXT NOT NULL,date TIMESTAMPTZ DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS payments(reference TEXT PRIMARY KEY,user_id TEXT NOT NULL,email TEXT NOT NULL,amount NUMERIC(14,2) NOT NULL,amount_kobo BIGINT NOT NULL,status TEXT NOT NULL,credited BOOLEAN DEFAULT FALSE,created_at TIMESTAMPTZ DEFAULT NOW(),credited_at TIMESTAMPTZ)`);
await db(`CREATE TABLE IF NOT EXISTS admins(id BIGSERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS admin_sessions(token TEXT PRIMARY KEY,admin_id BIGINT REFERENCES admins(id) ON DELETE CASCADE,created_at TIMESTAMPTZ DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL)`);
if(ADMIN_EMAIL&&ADMIN_PASSWORD&&!((await db(`SELECT id FROM admins WHERE LOWER(email)=LOWER($1)`,[ADMIN_EMAIL])).rows.length))await db(`INSERT INTO admins(email,password_hash) VALUES($1,$2)`,[ADMIN_EMAIL,hash(ADMIN_PASSWORD)]);
console.log("PostgreSQL database ready.");
}

const wallet=async id=>{let r=await db(`SELECT user_id,balance FROM wallets WHERE user_id=$1`,[id]);return r.rows[0]?{userId:r.rows[0].user_id,balance:Number(r.rows[0].balance)}:null};
const makeWallet=id=>db(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[id]);
const transactions=async id=>(await db(`SELECT type,service,amount,reference,status,date FROM transactions WHERE user_id=$1 ORDER BY date DESC`,[id])).rows.map(x=>({...x,amount:Number(x.amount)}));
const userEmail=async e=>(await db(`SELECT * FROM users WHERE LOWER(email)=LOWER($1)`,[e])).rows[0]||null;
const session=async req=>{let h=req.headers.authorization||"";if(!h.startsWith("Bearer "))return null;let r=await db(`SELECT u.* FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>NOW()`,[h.slice(7).trim()]);return r.rows[0]||null};
const userSession=async id=>{let t=token();await db(`INSERT INTO user_sessions(token,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')`,[t,id]);return t};

async function createUser(name,phone,email,password){
if(await userEmail(email))return{success:false,message:"An account with this email already exists."};
let r=await db(`INSERT INTO users(user_id,name,phone,email,password_hash,initials) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,user_id,name,phone,email,initials,created_at`,[uid(),name,phone,email,hash(password),initials(name)]);
await makeWallet(r.rows[0].user_id);
return{success:true,user:r.rows[0]};
}

// CHUNK 1 END
async function loginUser(email,password){
const u=await userEmail(email);
if(!u||!verify(password,u.password_hash))return{success:false,message:"Invalid email or password."};
return{success:true,message:"Login successful.",token:await userSession(u.id),user:{id:u.user_id,name:u.name,phone:u.phone,email:u.email,initials:u.initials}};
}

async function forgotPassword(email){
const u=await userEmail(email);
if(!u)return{success:true,message:"If the email exists, a reset request has been created."};
const t=token();
await db(`UPDATE password_resets SET used=TRUE WHERE user_id=$1 AND used=FALSE`,[u.id]);
await db(`INSERT INTO password_resets(user_id,token,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')`,[u.id,t]);
console.log("PASSWORD RESET TOKEN:",t);
return{success:true,message:"Password reset request created.",token:t};
}

async function resetPassword(t,password){
const r=await db(`SELECT u.id,u.user_id FROM password_resets p JOIN users u ON u.id=p.user_id WHERE p.token=$1 AND p.used=FALSE AND p.expires_at>NOW()`,[t]);
if(!r.rows.length)return{success:false,message:"Invalid or expired reset token."};
await db(`UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2`,[hash(password),r.rows[0].id]);
await db(`UPDATE password_resets SET used=TRUE WHERE token=$1`,[t]);
await db(`DELETE FROM user_sessions WHERE user_id=$1`,[r.rows[0].id]);
return{success:true,message:"Password reset successfully."};
}

async function updateProfile(id,name,phone,email){
const e=await db(`SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND user_id<>$2`,[email,id]);
if(e.rows.length)return{success:false,message:"Email is already in use."};
const r=await db(`UPDATE users SET name=$1,phone=$2,email=$3,initials=$4,updated_at=NOW() WHERE user_id=$5 RETURNING user_id,name,phone,email,initials`,[name,phone,email,initials(name),id]);
return r.rows.length?{success:true,user:r.rows[0]}:{success:false,message:"User not found."};
}

async function changePassword(id,current,next){
const r=await db(`SELECT password_hash FROM users WHERE user_id=$1`,[id]);
if(!r.rows.length||!verify(current,r.rows[0].password_hash))return{success:false,message:"Current password is incorrect."};
await db(`UPDATE users SET password_hash=$1,updated_at=NOW() WHERE user_id=$2`,[hash(next),id]);
return{success:true,message:"Password changed successfully."};
}

async function paystack(path,opt={}){
const r=await fetch(`https://api.paystack.co${path}`,{...opt,headers:{Authorization:`Bearer ${PAYSTACK_SECRET_KEY}`,"Content-Type":"application/json",...(opt.headers||{})}});
return{status:r.status,data:await r.json()};
}

async function fund(userId,email,amount){
if(!PAYSTACK_SECRET_KEY)return{success:false,message:"Paystack is not configured on the server."};
const reference=ref(),r=await paystack("/transaction/initialize",{method:"POST",body:JSON.stringify({email,amount:String(Math.round(amount*100)),currency:"NGN",reference,callback_url:`${FRONTEND_URL}/payment-success.html`,metadata:{userId,service:"BOLTIV Wallet Funding"}})});
if(!r.data.status)return{success:false,message:r.data.message||"Unable to initialize payment."};
await db(`INSERT INTO payments(reference,user_id,email,amount,amount_kobo,status) VALUES($1,$2,$3,$4,$5,'initialized')`,[reference,userId,email,amount,Math.round(amount*100)]);
return{success:true,message:"Payment initialized",reference,authorizationUrl:r.data.data.authorization_url,accessCode:r.data.data.access_code};
}

async function verifyPayment(reference){
if(!PAYSTACK_SECRET_KEY)return{success:false,message:"Paystack is not configured on the server."};
const p=(await db(`SELECT * FROM payments WHERE reference=$1`,[reference])).rows[0];
if(!p)return{success:false,message:"Payment reference not found."};
if(p.credited)return{success:true,alreadyCredited:true,reference,balance:(await wallet(p.user_id))?.balance||0};
const r=await paystack(`/transaction/verify/${encodeURIComponent(reference)}`,{method:"GET"});
if(!r.data.status)return{success:false,message:r.data.message||"Unable to verify payment."};
const x=r.data.data;
if(x.status!=="success"){await db(`UPDATE payments SET status=$1 WHERE reference=$2`,[x.status,reference]);return{success:false,message:`Payment status: ${x.status}`,status:x.status}};
if(x.currency!=="NGN"||Number(x.amount)!==Number(p.amount_kobo))return{success:false,message:"Payment details do not match."};
const c=await pool.connect();
try{
await c.query("BEGIN");
await c.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[p.user_id]);
const w=await c.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[Number(p.amount),p.user_id]);
await c.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status) VALUES($1,'credit','Wallet Funding',$2,$3,'successful') ON CONFLICT(reference) DO NOTHING`,[p.user_id,Number(p.amount),reference]);
await c.query(`UPDATE payments SET status='success',credited=TRUE,credited_at=NOW() WHERE reference=$1`,[reference]);
await c.query("COMMIT");
return{success:true,message:"Wallet funded successfully.",reference,amount:Number(p.amount),balance:Number(w.rows[0].balance)};
}catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
}

// CHUNK 2 END
