const http=require("node:http");
const crypto=require("node:crypto");
const {Pool}=require("pg");

const PORT=process.env.PORT||3000;
const DATABASE_URL=process.env.DATABASE_URL||"";
const BACKEND_PUBLIC_URL=(process.env.BACKEND_PUBLIC_URL||process.env.RENDER_EXTERNAL_URL||"").replace(/\/+$/,"");

const FLW_SECRET_KEY=process.env.FLW_SECRET_KEY||"";
const FLW_BASE_URL=(process.env.FLW_BASE_URL||"https://api.flutterwave.com/v3").replace(/\/+$/,"");
const FLW_SECRET_HASH=process.env.FLW_SECRET_HASH||"";
const FLW_CALLBACK_URL=process.env.FLW_CALLBACK_URL||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://boltiv.ng";

const ADMIN_EMAIL=process.env.ADMIN_EMAIL||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

const VTU_API_BASE_URL=process.env.VTU_API_BASE_URL||process.env.VTU_API_URL||"https://api.vtugate.com";
const VTU_API_KEY=process.env.VTU_API_KEY||"";
const CHEAPDATAHUB_API_BASE_URL=(process.env.CHEAPDATAHUB_API_BASE_URL||"https://www.cheapdatahub.ng/api/v1/resellers").replace(/\/+$/,"");
const CHEAPDATAHUB_API_KEY=process.env.CHEAPDATAHUB_API_KEY||"";

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


/* =========================================================
   CHEAPDATAHUB DATA CATALOG + SERVICE PRICING
   ========================================================= */

const CHEAPDATAHUB_PLAN_IDS_URL="https://www.cheapdatahub.ng/api/plan-ids/";

function normalizeDataNetwork(value){
const n=clean(value).toUpperCase().replace(/\s+/g,"");
if(n==="9MOBILE"||n==="ETISALAT")return "9MOBILE";
return ["MTN","AIRTEL","GLO"].includes(n)?n:"";
}

async function getService(key){
const serviceKey=clean(key).toLowerCase();
if(!serviceKey)return null;
const result=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services WHERE key=$1 LIMIT 1`,[serviceKey]);
if(!result.rows.length)return null;
const row=result.rows[0];
return {...row,fee:Number(row.fee||0),config:row.config&&typeof row.config==="object"?row.config:{}};
}

function pricingConfig(service){
const config=service?.config&&typeof service.config==="object"?service.config:{};
let mode=clean(config.markup_mode??config.markupMode??config.pricing_mode??config.pricingMode??"none").toLowerCase();
if(mode==="percent")mode="percentage";
if(mode==="fixed_amount")mode="fixed";
if(mode==="cost_plus")mode="percentage_plus_fixed";
const pct=Number(config.markup_pct??config.markupPercent??config.percentage??0);
const fixed=Number(config.markup_fixed??config.markupFixed??config.fixed??service?.fee??0);
return {
markup_mode:["none","percentage","fixed","percentage_plus_fixed"].includes(mode)?mode:"none",
markup_pct:Number.isFinite(pct)?Math.max(0,pct):0,
markup_fixed:Number.isFinite(fixed)?Math.max(0,fixed):0
};
}

function customerPriceFromCost(cost,pricing){
const n=Number(cost);
if(!Number.isFinite(n)||n<=0)return null;
const p=pricing||{};
let price=n;
if(p.markup_mode==="fixed")price+=Number(p.markup_fixed||0);
else if(p.markup_mode==="percentage")price+=n*Number(p.markup_pct||0)/100;
else if(p.markup_mode==="percentage_plus_fixed")price+=n*Number(p.markup_pct||0)/100+Number(p.markup_fixed||0);
return Number(price.toFixed(2));
}

function decodeHtml(value){
return String(value??"")
.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"')
.replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
.replace(/&#(\d+);/g,(_,n)=>{try{return String.fromCodePoint(Number(n));}catch{return "";}})
.replace(/&#x([0-9a-f]+);/gi,(_,n)=>{try{return String.fromCodePoint(parseInt(n,16));}catch{return "";}});
}

function htmlCellText(value){
return decodeHtml(String(value??"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ")).trim();
}

function parseCheapDataHubPlanTable(html){
const plans=[];
const rows=String(html||"").match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)||[];
for(const row of rows){
const cells=[...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>htmlCellText(m[1]));
if(cells.length<5)continue;
const network=normalizeDataNetwork(cells[0]);
const service=clean(cells[1]).toUpperCase();
const name=clean(cells[2]);
const bundleId=Number(cells[3].replace(/[^0-9]/g,""));
const price=Number(cells[4].replace(/[^0-9.]/g,""));
if(!network||service!=="DATA"||!Number.isInteger(bundleId)||bundleId<=0||!Number.isFinite(price)||price<=0)continue;
if(!name||/\(UNAVAILABLE\)/i.test(name))continue;
const sizeMatch=name.match(/(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
let sizeMb=0;
if(sizeMatch){const v=Number(sizeMatch[1]);sizeMb=sizeMatch[2].toUpperCase()==="GB"?Math.round(v*1024):Math.round(v);}
const validityMatch=name.match(/\b(\d+)\s*(?:day|days)\b/i);
plans.push({network_name:network,name,bundle_id:bundleId,price,size_mb:sizeMb,validity_days:validityMatch?Number(validityMatch[1]):0});
}
return plans;
}

async function fetchCheapDataHubDataPlans(network){
const selected=normalizeDataNetwork(network);
if(!selected)throw new Error("Unsupported network.");
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),10000);
try{
const response=await fetch(CHEAPDATAHUB_PLAN_IDS_URL,{headers:{Accept:"text/html,application/xhtml+xml"},signal:controller.signal});
if(!response.ok)throw new Error(`CheapDataHub plan page returned HTTP ${response.status}`);
const html=await response.text();
return parseCheapDataHubPlanTable(html).filter(p=>p.network_name===selected);
}finally{clearTimeout(timer);}
}

async function cheapDataHubRequest(endpoint,payload){
if(!CHEAPDATAHUB_API_KEY)return {success:false,statusCode:503,message:"CheapDataHub is not configured on the server."};
const response=await fetch(`${CHEAPDATAHUB_API_BASE_URL}/${endpoint.replace(/^\/+/,"")}/`,{
method:"POST",
headers:{Authorization:`Bearer ${CHEAPDATAHUB_API_KEY}`,"Content-Type":"application/json",Accept:"application/json"},
body:JSON.stringify(payload)
});
let data={};
try{data=await response.json();}catch{}
const statusValue=String(data.status??data.success??"").toLowerCase();
const success=response.ok&&(statusValue==="true"||statusValue==="success"||data.success===true||Boolean(data.reference&&response.status<300));
return {success,statusCode:response.status,data,message:data.message||data.error||(!response.ok?`CheapDataHub request failed (${response.status}).`:success?"Transaction successful.":"Transaction was not successful.")};
}

async function cheapDataHubGet(endpoint){
if(!CHEAPDATAHUB_API_KEY)return {success:false,statusCode:503,message:"CheapDataHub is not configured on the server."};
const response=await fetch(`${CHEAPDATAHUB_API_BASE_URL}/${endpoint.replace(/^\/+/,"")}/`,{method:"GET",headers:{Authorization:`Bearer ${CHEAPDATAHUB_API_KEY}`,Accept:"application/json"}});
let data={};try{data=await response.json();}catch{}
const statusValue=String(data.status??data.success??"").toLowerCase();
const success=response.ok&&(statusValue==="true"||statusValue==="success"||data.success===true);
return {success,statusCode:response.status,data,message:data.message||data.error||(!response.ok?`CheapDataHub request failed (${response.status}).`:success?"Request successful.":"Request was not successful.")};
}

async function debitWallet(userId,amount){
const client=await pool.connect();
try{
await client.query("BEGIN");
await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);
const r=await client.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[amount,userId]);
if(!r.rows.length){await client.query("ROLLBACK");return {success:false,message:"Insufficient wallet balance."};}
await client.query("COMMIT");
return {success:true,balance:Number(r.rows[0].balance)};
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

async function refundWallet(userId,amount){
await db(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2`,[amount,userId]);
}

async function insertVTUTransaction(data){
await db(`INSERT INTO transactions(user_id,type,service,amount,reference,status,recipient,metadata,idempotency_key,provider_reference,completed_at,refunded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT(reference) DO NOTHING`,[
data.userId,data.type||"debit",data.service,data.amount,data.reference,data.status,data.recipient||null,JSON.stringify(data.metadata||{}),data.idempotencyKey||null,data.providerReference||null,data.status==="successful"?new Date():null,data.status==="failed"?new Date():null]);
}

async function processVTUTransaction(user,data){
const userId=clean(user.user_id);
const service=clean(data.service||data.providerPayload?.service).toLowerCase();
const amount=Number(data.amount);
if(!userId)return {success:false,statusCode:401,message:"Unauthorized."};
if(!["airtime","data","exam_pin"].includes(service))return {success:false,statusCode:400,message:"This service is not available through CheapDataHub yet."};
if(!validAmount(amount))return {success:false,statusCode:400,message:"Invalid amount."};
if(service!=="exam_pin"&&!/^0\d{10}$/.test(clean(data.phone)))return {success:false,statusCode:400,message:"Please enter a valid 11-digit phone number."};
const idem=clean(data.idempotencyKey||data.idempotency_key);
if(idem){
const existing=await db(`SELECT reference,status,amount FROM transactions WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1`,[userId,idem]);
if(existing.rows.length)return {success:existing.rows[0].status==="successful"||existing.rows[0].status==="pending",message:existing.rows[0].status==="successful"?"Transaction already completed.":"Transaction is already being processed.",reference:existing.rows[0].reference,status:existing.rows[0].status,amount:Number(existing.rows[0].amount),alreadyProcessed:true};
}
const security=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[userId]);
if(!security.rows[0]?.transaction_pin_hash)return {success:false,statusCode:400,message:"Please set your Transaction PIN before making a purchase."};
const suppliedPin=String(data.transactionPin||"");
if(!/^\d{4}$/.test(suppliedPin)||!verifyPassword(suppliedPin,security.rows[0].transaction_pin_hash))return {success:false,statusCode:400,message:"Incorrect Transaction PIN."};
const referenceValue=reference("BOLTIV-TX");
const debit=await debitWallet(userId,amount);
if(!debit.success)return {success:false,statusCode:400,message:debit.message,balance:0};
let providerResult;
try{
if(service==="data"){
const bundleId=Number(data.bundle_id||data.providerPayload?.bundle_id||0);
if(!Number.isInteger(bundleId)||bundleId<=0)throw new Error("Invalid data plan.");
providerResult=await cheapDataHubRequest("data/purchase",{bundle_id:bundleId,phone_number:clean(data.phone)});
}else if(service==="exam_pin"){
const productId=Number(data.product_id||data.providerPayload?.product_id||0);
const quantity=Number(data.quantity||data.providerPayload?.quantity||1);
if(!Number.isInteger(productId)||productId<=0)throw new Error("Invalid exam PIN product.");
if(![1,2,5].includes(quantity))throw new Error("Exam PIN quantity must be 1, 2, or 5.");
providerResult=await cheapDataHubRequest("exam-pin/purchase",{product_id:productId,quantity});
}else{
const network=normalizeDataNetwork(data.network||data.providerPayload?.network);
const providerIds={MTN:1,GLO:2,AIRTEL:3,"9MOBILE":4};
const providerId=providerIds[network];
if(!providerId)throw new Error("Unsupported network.");
providerResult=await cheapDataHubRequest("airtime/purchase",{provider_id:providerId,phone_number:clean(data.phone),amount});
}
}catch(e){
await refundWallet(userId,amount);
await insertVTUTransaction({userId,service,amount,reference:referenceValue,status:"failed",recipient:clean(data.phone),idempotencyKey:idem,metadata:{error:e.message}});
return {success:false,statusCode:502,message:e.message||"Provider connection failed."};
}
const providerData=providerResult.data||{};
const providerReference=providerData.reference||providerData.transaction_id||providerData.data?.reference||providerData.data?.transaction_id||null;
if(!providerResult.success){
await refundWallet(userId,amount);
await insertVTUTransaction({userId,service,amount,reference:referenceValue,status:"failed",recipient:clean(data.phone),idempotencyKey:idem,providerReference,metadata:providerData});
return {success:false,statusCode:providerResult.statusCode>=500?502:400,message:providerResult.message||"Transaction failed. Your wallet has been refunded."};
}
const providerStatus=String(providerData.status||"").toLowerCase();
const pending=["pending","processing","initiated"].includes(providerStatus);
const finalStatus=pending?"pending":"successful";
await insertVTUTransaction({userId,service,amount,reference:referenceValue,status:finalStatus,recipient:clean(data.phone),idempotencyKey:idem,providerReference,metadata:providerData});
const wallet=await getWallet(userId);
return {success:true,status:finalStatus,message:providerResult.message|| (pending?"Your transaction is being processed.":"Transaction successful."),reference:referenceValue,providerReference,balance:wallet?.balance??debit.balance,providerData,delivery:providerData?.data?.delivery||providerData?.delivery||null,pins:providerData?.data?.delivery?.pins||providerData?.delivery?.pins||[]};
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
CREATE TABLE IF NOT EXISTS flutterwave_virtual_accounts(
id BIGSERIAL PRIMARY KEY,
owner_type TEXT NOT NULL DEFAULT 'user',
owner_id TEXT NOT NULL,
account_type TEXT NOT NULL DEFAULT 'static',
account_number TEXT UNIQUE NOT NULL,
account_name TEXT,
bank_name TEXT,
bank_code TEXT,
currency TEXT NOT NULL DEFAULT 'NGN',
amount NUMERIC(14,2) NOT NULL DEFAULT 0,
status TEXT NOT NULL DEFAULT 'active',
provider_account_id TEXT,
provider_customer_id TEXT,
tx_ref TEXT UNIQUE,
identity_type TEXT,
expiry_date TIMESTAMPTZ,
metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS flutterwave_va_account_idx ON flutterwave_virtual_accounts(account_number)`);
await db(`CREATE INDEX IF NOT EXISTS flutterwave_va_owner_idx ON flutterwave_virtual_accounts(owner_type,owner_id,created_at DESC)`);
await db(`CREATE UNIQUE INDEX IF NOT EXISTS flutterwave_static_owner_idx ON flutterwave_virtual_accounts(owner_type,owner_id) WHERE account_type='static'`);

await db(`
CREATE TABLE IF NOT EXISTS flutterwave_webhook_events(
id BIGSERIAL PRIMARY KEY,
event_id TEXT UNIQUE NOT NULL,
event_type TEXT,
payload JSONB NOT NULL,
processed BOOLEAN NOT NULL DEFAULT FALSE,
processed_at TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
// Backward-compatible migration for existing Boltiv databases.
await db(`ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT`);
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
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS icon TEXT`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS fee NUMERIC(14,2) NOT NULL DEFAULT 0`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS maintenance BOOLEAN NOT NULL DEFAULT FALSE`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
await db(`CREATE TABLE IF NOT EXISTS security_events(id BIGSERIAL PRIMARY KEY,admin_id BIGINT,event_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'info',details JSONB,ip TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events(created_at DESC)`);
for(const [key,name,icon] of [['airtime','Airtime','📱'],['data','Data','🌐'],['electricity','Electricity','💡'],['cable','Cable TV','📺'],['exam_pin','Exam PINs','🎓']]) await db(`INSERT INTO services(key,name,icon) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`,[key,name,icon]);
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



async function recordSecurityEvent(eventType,severity="info",details={},req=null,adminId=null){
try{
const safeDetails = details && typeof details === "object" ? details : {value:String(details??"")};
await db(
`INSERT INTO security_events(
admin_id,
event_type,
severity,
details,
ip
)
VALUES($1,$2,$3,$4::jsonb,$5)`,
[
adminId||null,
String(eventType||"security_event"),
String(severity||"info"),
JSON.stringify(safeDetails),
req ? requestIp(req) : null
]
);
}catch(err){
console.error("Failed to record security event:",err?.message||err);
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


/* ===================== ADMIN WALLET / REVENUE HELPERS ===================== */
async function ensureAdminWallet(client,adminId){
  await client.query(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);
}
async function addAdminLedger(client,adminId,type,amount,balanceAfter,description,ref){
  await client.query(`INSERT INTO admin_wallet_ledger(admin_id,type,amount,balance_after,reference,description) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(reference) DO NOTHING`,[adminId,type,Number(amount),Number(balanceAfter),String(ref),String(description)]);
}
async function getAdminWallet(adminId){
  await db(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);
  const row=(await db(`SELECT balance,created_at,updated_at FROM admin_wallets WHERE admin_id=$1`,[adminId])).rows[0]||{};
  return {balance:Number(row.balance||0),created_at:row.created_at||null,updated_at:row.updated_at||null};
}
async function ensureAdminRevenueWallet(client,adminId){
  await client.query(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);
}
async function addAdminRevenueLedger(client,adminId,type,amount,balanceAfter,description,ref){
  await client.query(`INSERT INTO admin_revenue_ledger(admin_id,type,amount,balance_after,reference,description) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(reference) DO NOTHING`,[adminId,type,Number(amount),Number(balanceAfter),String(ref),String(description)]);
}

/* ===================== FLUTTERWAVE VIRTUAL ACCOUNT FUNDING ===================== */

function flutterwaveConfigured(){
return Boolean(FLW_SECRET_KEY);
}

function normalizeNgPhone(phone){
let p=String(phone||"").replace(/\D/g,"");
if(p.startsWith("234")&&p.length===13)p="0"+p.slice(3);
if(p.length===10&&/^[789]/.test(p))p="0"+p;
return p;
}
function splitName(name,email){const value=clean(name)||clean(email).split("@")[0]||"BOLTIV User";const parts=value.split(/\s+/).filter(Boolean);return{first:parts.shift()||"BOLTIV",last:parts.join(" ")||"User"};}
function flutterwaveError(r,fallback="Flutterwave request failed."){const message=r?.data?.message||r?.data?.error||r?.message;return typeof message==="string"&&message.trim()?message.trim():fallback;}
async function flutterwaveRequest(path,options={}){
if(!flutterwaveConfigured())return{success:false,statusCode:503,message:"Flutterwave is not configured."};
try{const response=await fetch(`${FLW_BASE_URL}${path}`,{...options,headers:{Authorization:`Bearer ${FLW_SECRET_KEY}`,"Content-Type":"application/json",Accept:"application/json",...(options.headers||{})}});let data={};try{data=await response.json();}catch{}return{success:Boolean(response.ok&&data?.status!=="error"),statusCode:response.status,data};}catch(error){console.error("FLUTTERWAVE REQUEST ERROR:",error.message);return{success:false,statusCode:502,message:"Unable to connect to Flutterwave."};}
}
function parseDateOrNull(value){if(!value||String(value).toUpperCase()==="N/A")return null;const d=new Date(value);return Number.isNaN(d.getTime())?null:d;}
function extractFlutterwaveVA(data){const d=data?.data||data?.result||data||{};return{accountNumber:clean(d.account_number||d.accountNumber||d.transfer_account||d.account?.account_number),accountName:clean(d.account_name||d.accountName||d.full_name||d.name),bankName:clean(d.bank_name||d.bankName||d.transfer_bank||d.bank?.name),bankCode:clean(d.bank_code||d.bankCode||d.transfer_bank_code||d.bank?.code),providerAccountId:clean(d.id||d.account_id||d.virtual_account_id),providerCustomerId:clean(d.customer_id||d.customerId),txRef:clean(d.tx_ref||d.txRef),expiryDate:parseDateOrNull(d.expiry_date||d.expiryDate),raw:d};}
async function getFlutterwaveStaticFundingAccount(user){const r=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type='user' AND owner_id=$1 AND account_type='static' AND status='active' LIMIT 1`,[user.user_id]);return{success:true,account:r.rows[0]||null};}
async function createFlutterwaveVirtualAccount({ownerType="user",ownerId,user,accountType="static",amount=0,identityType="",identityNumber=""}){
if(!flutterwaveConfigured())throw new Error("Flutterwave is not configured. Set FLW_SECRET_KEY on the server.");
if(!ownerId)throw new Error("Account owner is required.");
if(!["static","dynamic"].includes(accountType))throw new Error("Invalid virtual account type.");
if(accountType==="dynamic"&&(!Number.isFinite(Number(amount))||Number(amount)<=0))throw new Error("A valid deposit amount is required for a dynamic account.");
if(accountType==="static"){
const existing=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type=$1 AND owner_id=$2 AND account_type='static' AND status='active' LIMIT 1`,[ownerType,ownerId]);if(existing.rows.length)return{success:true,account:existing.rows[0],existing:true};
if(!["nin","bvn"].includes(String(identityType).toLowerCase()))throw new Error("Choose NIN or BVN for a permanent account.");
if(!/^\d{11}$/.test(String(identityNumber||"")))throw new Error("Enter a valid 11-digit NIN or BVN.");
}
const name=splitName(user?.name,user?.email),email=clean(user?.email),phone=normalizeNgPhone(user?.phone);if(!email)throw new Error("A valid email address is required.");if(!phone||phone.length<11)throw new Error("A valid Nigerian phone number is required on your profile.");
const ref=reference(`BOLTIV-${accountType.toUpperCase()}`).replace(/[^a-zA-Z0-9-]/g,"-").slice(0,42);
const payload={email,amount:accountType==="static"?0:Number(amount),currency:"NGN",firstname:name.first,lastname:name.last,tx_ref:ref,is_permanent:accountType==="static",narration:`BOLTIV ${accountType} funding`,phonenumber:phone};
if(accountType==="static")payload[String(identityType).toLowerCase()]=String(identityNumber);
const r=await flutterwaveRequest("/virtual-account-numbers",{method:"POST",body:JSON.stringify(payload)});if(!r.success)throw new Error(flutterwaveError(r,"Unable to create Flutterwave virtual account."));
const account=extractFlutterwaveVA(r.data);if(!account.accountNumber)throw new Error("Flutterwave did not return a virtual account number.");
const result=await db(`INSERT INTO flutterwave_virtual_accounts(owner_type,owner_id,account_type,account_number,account_name,bank_name,bank_code,currency,amount,status,provider_account_id,provider_customer_id,tx_ref,identity_type,expiry_date,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,'NGN',$8,'active',$9,$10,$11,$12,$13,$14) ON CONFLICT(account_number) DO UPDATE SET account_name=EXCLUDED.account_name,bank_name=EXCLUDED.bank_name,bank_code=EXCLUDED.bank_code,amount=EXCLUDED.amount,status='active',provider_account_id=EXCLUDED.provider_account_id,provider_customer_id=EXCLUDED.provider_customer_id,expiry_date=EXCLUDED.expiry_date,metadata=EXCLUDED.metadata,updated_at=NOW() RETURNING *`,[ownerType,ownerId,accountType,account.accountNumber,account.accountName||`${name.first} ${name.last}`,account.bankName,account.bankCode||null,Number(accountType==="static"?0:amount),account.providerAccountId||null,account.providerCustomerId||null,ref,accountType==="static"?String(identityType).toLowerCase():null,account.expiryDate,JSON.stringify(account.raw||{})]);
return{success:true,account:result.rows[0],existing:false};
}
async function createCustomerFlutterwaveStaticAccount(user,identityType,identityNumber){return createFlutterwaveVirtualAccount({ownerType:"user",ownerId:user.user_id,user,accountType:"static",identityType,identityNumber});}
async function createCustomerFlutterwaveDynamicAccount(user,amount){return createFlutterwaveVirtualAccount({ownerType:"user",ownerId:user.user_id,user,accountType:"dynamic",amount});}
async function creditFlutterwaveVirtualAccount(payload){
const data=payload?.data||payload||{};const accountNumber=clean(data?.account?.account_number||data?.account_number||data?.transfer_account||payload?.meta_data?.account_number||payload?.meta?.account_number);const amount=Number(data?.amount||data?.amount_settled||data?.charged_amount||0);const txId=clean(data?.id||data?.flw_ref||data?.tx_ref||payload?.id);const txRef=clean(data?.tx_ref||data?.reference||"");if(!Number.isFinite(amount)||amount<=0)throw new Error("Flutterwave webhook has an invalid amount.");if(!txId&&!txRef&&!accountNumber)throw new Error("Flutterwave webhook is missing a transaction identifier.");let va=null;if(txRef)va=(await db(`SELECT * FROM flutterwave_virtual_accounts WHERE tx_ref=$1 LIMIT 1`,[txRef])).rows[0]||null;if(!va&&accountNumber)va=(await db(`SELECT * FROM flutterwave_virtual_accounts WHERE account_number=$1 LIMIT 1`,[accountNumber])).rows[0]||null;if(!va)throw new Error("No BOLTIV owner is mapped to this Flutterwave virtual-account payment.");
if(txId || txRef){
const verified=/^\d+$/.test(txId)?await flutterwaveRequest(`/transactions/${encodeURIComponent(txId)}/verify`):await flutterwaveRequest(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
const vd=verified.data?.data||{};
if(!verified.success||String(vd.status||"").toLowerCase()!=="successful")throw new Error(flutterwaveError(verified,"Flutterwave transaction verification failed."));
if(String(vd.currency||"").toUpperCase()!=="NGN")throw new Error("Flutterwave transaction currency is not NGN.");
if(Number(vd.amount||0)<=0)throw new Error("Flutterwave transaction amount is invalid.");
}
const client=await pool.connect();try{await client.query("BEGIN");const eventId=txId||txRef||accountNumber;const existing=await client.query(`SELECT processed FROM flutterwave_webhook_events WHERE event_id=$1 FOR UPDATE`,[eventId]);if(existing.rows.length&&existing.rows[0].processed){await client.query("COMMIT");return{success:true,duplicate:true};}await client.query(`INSERT INTO flutterwave_webhook_events(event_id,event_type,payload,processed) VALUES($1,$2,$3,FALSE) ON CONFLICT(event_id) DO NOTHING`,[eventId,String(payload?.event||payload?.type||"charge.completed"),JSON.stringify(payload)]);
if(va.owner_type==="admin"){const adminId=Number(va.owner_id);await ensureAdminWallet(client,adminId);const wr=await client.query(`UPDATE admin_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[amount,adminId]);if(!wr.rows.length)throw new Error("Admin wallet could not be credited.");await addAdminLedger(client,adminId,"funding",amount,Number(wr.rows[0].balance),"Flutterwave virtual-account funding",`FLW-ADMIN-${eventId}`);await client.query(`UPDATE flutterwave_webhook_events SET processed=TRUE,processed_at=NOW() WHERE event_id=$1`,[eventId]);await client.query("COMMIT");return{success:true,duplicate:false,amount,ownerType:"admin",adminId};}
const userId=String(va.owner_id);await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET balance=wallets.balance+$2,updated_at=NOW()`,[userId,amount]);const referenceValue=`FUND-${eventId}`;await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,provider_reference,metadata) VALUES($1,'credit','Wallet Funding',$2,$3,'successful',NOW(),$4,$5) ON CONFLICT(reference) DO NOTHING`,[userId,amount,referenceValue,txRef||txId,JSON.stringify({provider:"flutterwave",account_number:accountNumber||va.account_number,account_type:va.account_type,payload})]);await client.query(`UPDATE flutterwave_webhook_events SET processed=TRUE,processed_at=NOW() WHERE event_id=$1`,[eventId]);await client.query("COMMIT");try{await addNotification(userId,"Wallet credited",`Your wallet was credited with ₦${amount.toLocaleString("en-NG",{minimumFractionDigits:2})} via Flutterwave bank transfer.` ,"payment");}catch{}return{success:true,duplicate:false,amount,userId};}catch(e){try{await client.query("ROLLBACK")}catch{}throw e;}finally{client.release();}
}
async function getAdminFlutterwaveFundingAccount(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};const r=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type='admin' AND owner_id=$1 AND account_type='dynamic' AND status='active' AND (expiry_date IS NULL OR expiry_date>NOW()) ORDER BY created_at DESC LIMIT 1`,[String(admin.id)]);return{success:true,account:r.rows[0]||null};}
async function createAdminFlutterwaveFundingAccount(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};const b=await body(req),amount=Number(b.amount);if(!validAmount(amount)||amount<100)return{success:false,statusCode:400,message:"Enter an amount of at least ₦100."};try{return await createFlutterwaveVirtualAccount({ownerType:"admin",ownerId:String(admin.id),user:{name:"BOLTIV TECHNOLOGIES LIMITED",email:admin.email,phone:process.env.ADMIN_PHONE||"08000000000"},accountType:"dynamic",amount});}catch(e){return{success:false,statusCode:400,message:e.message||"Unable to create Flutterwave admin funding account."};}
}

function normalizeNgPhone(phone){
let p=String(phone||"").replace(/\D/g,"");
if(p.startsWith("234")&&p.length===13) p="0"+p.slice(3);
if(p.length===10&&/^[789]/.test(p)) p="0"+p;
return p;
}

function splitName(name,email){
const value=clean(name)||clean(email).split("@")[0]||"BOLTIV User";
const parts=value.split(/\s+/).filter(Boolean);
return {first:parts.shift()||"BOLTIV",last:parts.join(" ")||"User"};
}

function flutterwaveError(r,fallback="Flutterwave request failed."){
const message=r?.data?.message||r?.data?.error||r?.message;
return typeof message==="string"&&message.trim()?message.trim():fallback;
}

async function flutterwaveBanks(){
const r=await flutterwaveRequest("/banks/NG?include_provider_type=1");
if(!r.success)return{success:false,statusCode:r.statusCode||502,message:flutterwaveError(r,"Unable to load Nigerian banks.")};
return{success:true,banks:Array.isArray(r.data?.data)?r.data.data.map(x=>({code:String(x.code||x.bank_code||""),name:String(x.name||x.bank_name||"")})).filter(x=>x.code&&x.name):[]};
}
async function resolveFlutterwaveAccount(bankCode,accountNumber){
const r=await flutterwaveRequest("/accounts/resolve",{method:"POST",body:JSON.stringify({account_bank:String(bankCode),account_number:String(accountNumber)})});
const d=r.data?.data||{};const name=d.account_name||d.accountName;
if(!r.success||!name)return{success:false,statusCode:r.statusCode||400,message:flutterwaveError(r,"Unable to verify the bank account.")};
return{success:true,accountName:String(name).trim(),accountNumber:String(d.account_number||accountNumber).trim()};
}
async function flutterwaveBankTransfer({amount,bankCode,accountNumber,narration,referenceValue}){
const payload={account_bank:String(bankCode),account_number:String(accountNumber),amount:Number(amount),currency:"NGN",debit_currency:"NGN",beneficiary_name:"BOLTIV Technologies Limited",reference:String(referenceValue),narration:String(narration||"BOLTIV revenue withdrawal")};
if(FLW_CALLBACK_URL)payload.callback_url=FLW_CALLBACK_URL;
const r=await flutterwaveRequest("/transfers",{method:"POST",body:JSON.stringify(payload),headers:{"X-Idempotency-Key":String(referenceValue)}});
if(!r.success)return{success:false,statusCode:r.statusCode||400,message:flutterwaveError(r,"Flutterwave transfer failed.")};
const d=r.data?.data||{};const raw=String(d.status||r.data?.status||"NEW").toUpperCase();
const status=["SUCCESSFUL","COMPLETED"].includes(raw)?"successful":(["FAILED","REVERSED","CANCELLED","CANCELED"].includes(raw)?"failed":"processing");
return{success:true,status,transferId:d.id||null,providerReference:d.reference||null,message:r.data?.message||raw,data:r.data};
}
async function getFlutterwaveTransferStatus(id){
const r=await flutterwaveRequest(`/transfers/${encodeURIComponent(id)}`);
if(!r.success)return{success:false,statusCode:r.statusCode||502,message:flutterwaveError(r,"Unable to check transfer status.")};
const d=r.data?.data||{};const raw=String(d.status||"").toUpperCase();
const status=["SUCCESSFUL","COMPLETED"].includes(raw)?"successful":(["FAILED","REVERSED","CANCELLED","CANCELED"].includes(raw)?"failed":"processing");
return{success:true,status,providerMessage:d.complete_message||r.data?.message||raw,data:d};
}

async function adminRevenue(req,action){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
if(action==='summary'){
await db(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
const w=(await db(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1`,[admin.id])).rows[0];
const r=(await db(`SELECT COALESCE(SUM(CASE WHEN type='sale' THEN amount ELSE 0 END),0) AS sales,COALESCE(SUM(CASE WHEN type='refund' THEN ABS(amount) ELSE 0 END),0) AS refunds FROM admin_revenue_ledger WHERE admin_id=$1`,[admin.id])).rows[0];
const gross=(await db(`SELECT COALESCE(SUM(CASE WHEN type='debit' AND status='successful' THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit FROM transactions`)).rows[0];
const reserved=(await db(`SELECT COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount ELSE 0 END),0) AS reserved FROM admin_revenue_withdrawals WHERE admin_id=$1`,[admin.id])).rows[0];
const balance=Number(w?.balance||0),hold=Number(reserved?.reserved||0);const rows=await db(`SELECT id,amount,bank_code,account_number,account_name,status,reference,provider_transfer_id,provider_message,created_at,updated_at,completed_at FROM admin_revenue_withdrawals WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 100`,[admin.id]);
return{success:true,summary:{balance,sales:Number(r?.sales||0),refunds:Number(r?.refunds||0),grossProfit:Number(gross?.gross_profit||0),reserved:hold,available:Math.max(0,Number((balance-hold).toFixed(2)))},withdrawals:rows.rows.map(x=>({...x,amount:Number(x.amount||0),provider:"flutterwave"}))};
}
if(action==='banks')return flutterwaveBanks();
if(action==='verify'){
const b=await body(req),bankCode=clean(b.bankCode||b.bank_code),accountNumber=clean(b.accountNumber||b.account_number);
if(!bankCode||!/^[0-9]{10}$/.test(accountNumber))return{success:false,statusCode:400,message:"Enter a valid Nigerian bank code and 10-digit account number."};
return resolveFlutterwaveAccount(bankCode,accountNumber);
}
if(action==='status'){
const b=await body(req),id=Number(b.id||0);if(!id)return{success:false,statusCode:400,message:"Withdrawal ID is required."};
const row=(await db(`SELECT * FROM admin_revenue_withdrawals WHERE id=$1 AND admin_id=$2 LIMIT 1`,[id,admin.id])).rows[0];if(!row)return{success:false,statusCode:404,message:"Withdrawal not found."};
if(!row.provider_transfer_id||["successful","failed"].includes(String(row.status)))return{success:true,withdrawal:{...row,amount:Number(row.amount),provider:"flutterwave"}};
const tr=await getFlutterwaveTransferStatus(row.provider_transfer_id);if(!tr.success)return tr;
if(tr.status!==row.status){await db(`UPDATE admin_revenue_withdrawals SET status=$1,provider_message=$2,updated_at=NOW(),completed_at=CASE WHEN $1 IN ('successful','failed') THEN NOW() ELSE completed_at END WHERE id=$3`,[tr.status,tr.providerMessage||tr.status,row.id]);if(tr.status==='failed')await reverseRevenueWithdrawal(admin.id,row.id,row.amount,tr.providerMessage||'Flutterwave transfer failed.');}
const fresh=(await db(`SELECT * FROM admin_revenue_withdrawals WHERE id=$1`,[row.id])).rows[0];return{success:true,withdrawal:{...fresh,amount:Number(fresh.amount),provider:"flutterwave"}};
}
if(action==='withdraw'){
const b=await body(req),amount=Number(b.amount),bankCode=clean(b.bankCode||b.bank_code),accountNumber=clean(b.accountNumber||b.account_number);
if(!Number.isFinite(amount)||amount<1000)return{success:false,statusCode:400,message:"Minimum withdrawal is ₦1,000."};
if(!bankCode||!/^[0-9]{10}$/.test(accountNumber))return{success:false,statusCode:400,message:"Enter a valid Nigerian bank account."};
if(!flutterwaveConfigured())return{success:false,statusCode:503,message:"Flutterwave is not configured."};
const verified=await resolveFlutterwaveAccount(bankCode,accountNumber);if(!verified.success)return verified;
const client=await pool.connect();let row;
try{await client.query("BEGIN");await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`boltiv-revenue-withdraw:${admin.id}`]);await ensureAdminRevenueWallet(client,admin.id);const w=await client.query(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1 FOR UPDATE`,[admin.id]);const balance=Number(w.rows[0]?.balance||0);const reserved=(await client.query(`SELECT COALESCE(SUM(amount),0) AS reserved FROM admin_revenue_withdrawals WHERE admin_id=$1 AND status IN ('pending','processing')`,[admin.id])).rows[0];const available=Math.max(0,Number((balance-Number(reserved?.reserved||0)).toFixed(2)));if(amount>available){await client.query("ROLLBACK");return{success:false,statusCode:400,message:`Insufficient BOLTIV balance. Available: ₦${available.toLocaleString("en-NG",{minimumFractionDigits:2})}.`};}const ref=reference("BOLTIV-WD").toLowerCase().replace(/[^a-z0-9_-]/g,"-").slice(0,50);const br=await client.query(`UPDATE admin_revenue_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[amount,admin.id]);row=(await client.query(`INSERT INTO admin_revenue_withdrawals(admin_id,amount,bank_code,account_number,account_name,status,reference) VALUES($1,$2,$3,$4,$5,'processing',$6) RETURNING *`,[admin.id,amount,bankCode,verified.accountNumber,verified.accountName,ref])).rows[0];await addAdminRevenueLedger(client,admin.id,'withdrawal',-amount,Number(br.rows[0].balance),'Admin Flutterwave bank withdrawal',`WD-${ref}`);await client.query("COMMIT");}catch(e){try{await client.query("ROLLBACK")}catch{};return{success:false,statusCode:500,message:"Unable to reserve BOLTIV balance for withdrawal."};}finally{client.release();}
const tr=await flutterwaveBankTransfer({amount,bankCode,accountNumber:verified.accountNumber,narration:"BOLTIV revenue withdrawal",referenceValue:row.reference});
if(!tr.success){await reverseRevenueWithdrawal(admin.id,row.id,row.amount,tr.message||"Flutterwave transfer failed");return{success:false,statusCode:tr.statusCode||400,message:tr.message||"Flutterwave transfer failed.",withdrawalId:row.id};}
const status=tr.status||"processing";
if(status==='failed')await reverseRevenueWithdrawal(admin.id,row.id,row.amount,tr.message||"Flutterwave transfer failed");
else await db(`UPDATE admin_revenue_withdrawals SET status=$1,provider_transfer_id=$2,provider_message=$3,updated_at=NOW(),completed_at=CASE WHEN $1 IN ('successful','failed') THEN NOW() ELSE NULL END WHERE id=$4`,[status,tr.transferId||null,tr.message||status,row.id]);
await adminAudit(admin,'revenue_withdrawal_created','revenue_withdrawal',String(row.id),{amount,bankCode,accountNumber:verified.accountNumber,accountName:verified.accountName,reference:row.reference,status,provider:'flutterwave',providerTransferId:tr.transferId},req);
return{success:true,message:status==='successful'?"BOLTIV withdrawal completed.":"BOLTIV withdrawal submitted to Flutterwave and is being processed.",withdrawalId:row.id,reference:row.reference,status,accountName:verified.accountName,amount,provider:"flutterwave"};
}
return{success:false,statusCode:400,message:"Unknown revenue action."};
}
async function reverseRevenueWithdrawal(adminId,id,amount,reason){const c=await pool.connect();try{await c.query("BEGIN");const row=(await c.query(`SELECT * FROM admin_revenue_withdrawals WHERE id=$1 AND admin_id=$2 FOR UPDATE`,[id,adminId])).rows[0];if(!row){await c.query("ROLLBACK");return;}if(row.status==='failed'){await c.query("COMMIT");return;}await ensureAdminRevenueWallet(c,adminId);const w=await c.query(`UPDATE admin_revenue_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(amount),adminId]);if(w.rows.length)await addAdminRevenueLedger(c,adminId,'withdrawal_reversal',Number(amount),Number(w.rows[0].balance),reason,`REVERSAL-${row.reference}`);await c.query(`UPDATE admin_revenue_withdrawals SET status='failed',provider_message=$1,updated_at=NOW(),completed_at=NOW() WHERE id=$2`,[reason,id]);await c.query("COMMIT");}catch(e){try{await c.query("ROLLBACK")}catch{}console.error("REVENUE WITHDRAWAL REVERSAL ERROR",e)}finally{c.release();}}

async function adminWalletInfo(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};const wallet=await getAdminWallet(admin.id);const ledger=(await db(`SELECT id,type,amount,balance_after,reference,description,created_at FROM admin_wallet_ledger WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 100`,[admin.id])).rows.map(x=>({...x,amount:Number(x.amount||0),balance_after:Number(x.balance_after||0)}));return{success:true,wallet,ledger};}
async function initializeAdminWalletFunding(req){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
const b=await body(req),amount=Number(b.amount);if(!validAmount(amount)||amount<100)return{success:false,statusCode:400,message:"Enter an amount of at least ₦100."};
try{return await createFlutterwaveVirtualAccount({ownerType:"admin",ownerId:String(admin.id),user:{name:"BOLTIV TECHNOLOGIES LIMITED",email:admin.email,phone:process.env.ADMIN_PHONE||"08000000000"},accountType:"dynamic",amount});}
catch(e){return{success:false,statusCode:400,message:e.message||"Unable to create Flutterwave admin funding account."};}
}
async function verifyAdminWalletFunding(req){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
const b=await body(req),accountNumber=clean(b.accountNumber||b.account_number);if(!accountNumber)return{success:false,statusCode:400,message:"Funding account number is required."};
const r=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type='admin' AND owner_id=$1 AND account_number=$2 LIMIT 1`,[String(admin.id),accountNumber]);if(!r.rows.length)return{success:false,statusCode:404,message:"Flutterwave admin funding account not found."};
return{success:true,account:r.rows[0],message:"Transfer to this Flutterwave account. The operating wallet will be credited automatically after Flutterwave confirms the transfer."};
}


/* ===================== ADMIN DASHBOARD API HELPERS ===================== */

async function adminCsrfToken(req){
  const sessionToken=getAdminSessionToken(req);
  if(!sessionToken)return null;
  let r=await db(`SELECT csrf_token FROM admin_sessions WHERE token=$1 AND expires_at>NOW()`,[sessionToken]);
  if(!r.rows.length)return null;
  let csrf=r.rows[0].csrf_token;
  if(!csrf){
    csrf=token();
    await db(`UPDATE admin_sessions SET csrf_token=$1 WHERE token=$2`,[csrf,sessionToken]);
  }
  return csrf;
}

async function requireAdmin(req){
  return await adminFromToken(req);
}

async function requireAdminCsrf(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const supplied=String(req.headers["x-admin-csrf"]||"");
  const expected=await adminCsrfToken(req);
  if(!expected||!supplied||supplied!==expected)return{success:false,statusCode:403,message:"Invalid admin CSRF token."};
  return{success:true,admin};
}

async function adminMe(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  return{success:true,admin:{id:admin.id,email:admin.email}};
}

async function adminStatsResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};

  const users=(await db(`SELECT COUNT(*)::int AS count FROM users`)).rows[0];
  const active=(await db(`SELECT COUNT(*)::int AS count FROM users WHERE COALESCE(status,'active')<>'suspended'`)).rows[0];
  const wallet=(await db(`SELECT COALESCE(SUM(balance),0) AS total FROM wallets`)).rows[0];
  const tx=(await db(`SELECT COUNT(*)::int AS count FROM transactions`)).rows[0];
  const payments=(await db(`SELECT COUNT(*)::int AS count FROM payments`)).rows[0];
  const statuses=(await db(`SELECT
    COUNT(*) FILTER(WHERE status='successful')::int AS successful,
    COUNT(*) FILTER(WHERE status IN ('pending','processing'))::int AS pending,
    COUNT(*) FILTER(WHERE status='failed')::int AS failed,
    COALESCE(SUM(CASE WHEN type='debit' AND status='successful'
      THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit
    FROM transactions`)).rows[0];

  await db(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
  await db(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
  const aw=(await db(`SELECT balance FROM admin_wallets WHERE admin_id=$1`,[admin.id])).rows[0];
  const rw=(await db(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1`,[admin.id])).rows[0];

  return{
    success:true,
    stats:{
      users:Number(users?.count||0),
      walletBalance:Number(wallet?.total||0),
      transactions:Number(tx?.count||0),
      payments:Number(payments?.count||0),
      grossProfit:Number(statuses?.gross_profit||0),
      successful:Number(statuses?.successful||0),
      pending:Number(statuses?.pending||0),
      failed:Number(statuses?.failed||0),
      activeUsers:Number(active?.count||0),
      adminWalletBalance:Number(aw?.balance||0),
      adminRevenueBalance:Number(rw?.balance||0)
    }
  };
}

async function adminUsersResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const r=await db(`SELECT u.user_id,u.name,u.email,u.phone,COALESCE(u.status,'active') AS status,
    COALESCE(w.balance,0) AS balance,u.created_at
    FROM users u LEFT JOIN wallets w ON w.user_id=u.user_id
    ORDER BY u.created_at DESC LIMIT 1000`);
  return{success:true,users:r.rows.map(x=>({...x,balance:Number(x.balance||0)}))};
}

async function adminTransactionsResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const r=await db(`SELECT t.id,t.user_id,t.type,t.service,t.amount,t.reference,t.status,t.date,
    t.provider_reference,t.metadata,u.email,u.name,
    COALESCE((t.metadata->'pricing'->>'providerCost')::numeric,0) AS provider_cost,
    COALESCE((t.metadata->'pricing'->>'grossProfit')::numeric,0) AS gross_profit
    FROM transactions t LEFT JOIN users u ON u.user_id=t.user_id
    ORDER BY t.date DESC LIMIT 1000`);
  return{success:true,transactions:r.rows.map(x=>({...x,amount:Number(x.amount||0),providerCost:Number(x.provider_cost||0),grossProfit:Number(x.gross_profit||0)}))};
}

async function adminPaymentsResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const r=await db(`SELECT id,reference,user_id,email,amount,amount_kobo,status,credited,created_at,credited_at
    FROM payments ORDER BY created_at DESC LIMIT 1000`);
  return{success:true,payments:r.rows.map(x=>({...x,amount:Number(x.amount||0),amount_kobo:Number(x.amount_kobo||0),credited:Boolean(x.credited)}))};
}

async function adminSupport(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="list"){
    const r=await db(`SELECT t.id,t.user_id,t.subject,t.message,t.status,t.created_at,t.updated_at,u.name,u.email
      FROM support_tickets t LEFT JOIN users u ON u.user_id=t.user_id
      ORDER BY t.updated_at DESC LIMIT 200`);
    return{success:true,tickets:r.rows};
  }
  const b=await body(req);
  const ticketId=Number(b.ticketId||b.ticket_id);
  if(!Number.isInteger(ticketId)||ticketId<1)return{success:false,statusCode:400,message:"Invalid ticket."};
  if(action==="status"){
    const status=clean(b.status).toLowerCase();
    if(!["open","pending","resolved","closed"].includes(status))return{success:false,statusCode:400,message:"Invalid ticket status."};
    const r=await db(`UPDATE support_tickets SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status`,[status,ticketId]);
    if(!r.rows.length)return{success:false,statusCode:404,message:"Support ticket not found."};
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [admin.id,"support_status","ticket",String(ticketId),JSON.stringify({status}),requestIp(req)]);
    return{success:true,ticket:r.rows[0]};
  }
  if(action==="reply"){
    const message=clean(b.message);
    if(message.length<1)return{success:false,statusCode:400,message:"Reply message is required."};
    const t=await db(`SELECT id FROM support_tickets WHERE id=$1`,[ticketId]);
    if(!t.rows.length)return{success:false,statusCode:404,message:"Support ticket not found."};
    await db(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'admin',$2,$3)`,[ticketId,String(admin.id),message]);
    await db(`UPDATE support_tickets SET status='pending',updated_at=NOW() WHERE id=$1`,[ticketId]);
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [admin.id,"support_reply","ticket",String(ticketId),JSON.stringify({message}),requestIp(req)]);
    return{success:true,message:"Reply sent."};
  }
  return{success:false,statusCode:400,message:"Unsupported support action."};
}

async function adminAuditResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const r=await db(`SELECT l.id,l.admin_id,a.email,l.action,l.target_type,l.target_id,l.details,l.ip,l.created_at
    FROM admin_audit_logs l LEFT JOIN admins a ON a.id=l.admin_id
    ORDER BY l.created_at DESC LIMIT 500`);
  return{success:true,logs:r.rows};
}

async function adminServices(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="list"){
    const r=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services ORDER BY name`);
    return{success:true,services:r.rows.map(x=>({...x,fee:Number(x.fee||0),config:x.config||{}}))};
  }
  const b=await body(req),key=clean(b.key);
  if(!key)return{success:false,statusCode:400,message:"Service key is required."};
  const r=await db(`UPDATE services SET enabled=$1,maintenance=$2,fee=$3,config=$4::jsonb,updated_at=NOW() WHERE key=$5 RETURNING key,name,icon,enabled,fee,maintenance,config,updated_at`,
    [Boolean(b.enabled),Boolean(b.maintenance),Number(b.fee||0),JSON.stringify(b.config||{}),key]);
  if(!r.rows.length)return{success:false,statusCode:404,message:"Service not found."};
  await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
    [admin.id,"service_update","service",key,JSON.stringify({enabled:Boolean(b.enabled),maintenance:Boolean(b.maintenance),fee:Number(b.fee||0)}),requestIp(req)]);
  return{success:true,service:{...r.rows[0],fee:Number(r.rows[0].fee||0)}};
}

async function adminSettings(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="get"){
    const r=await db(`SELECT key,value FROM platform_settings`);
    const settings={};
    for(const row of r.rows)settings[row.key]=row.value;
    return{success:true,settings};
  }
  const b=await body(req);
  for(const key of ["maintenance_mode","registration_enabled"]){
    if(Object.prototype.hasOwnProperty.call(b,key)){
      await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,
        [key,JSON.stringify(Boolean(b[key]))]);
    }
  }
  return adminSettings(req,"get");
}

async function adminSecurity(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="events"){
    const r=await db(`SELECT s.id,s.admin_id,a.email,s.event_type,s.severity,s.details,s.ip,s.created_at
      FROM security_events s LEFT JOIN admins a ON a.id=s.admin_id
      ORDER BY s.created_at DESC LIMIT 500`);
    return{success:true,events:r.rows};
  }
  if(action==="sessions"){
    const r=await db(`SELECT s.created_at,s.expires_at,a.email,s.admin_id
      FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
      WHERE s.expires_at>NOW() ORDER BY s.created_at DESC`);
    return{success:true,sessions:r.rows};
  }
  if(action==="revoke"){
    const current=getAdminSessionToken(req);
    const r=await db(`DELETE FROM admin_sessions WHERE admin_id=$1 AND token<>$2`,[admin.id,current||""]);
    await recordSecurityEvent("admin_sessions_revoked","warning",{revoked:r.rowCount},req,admin.id);
    return{success:true,revoked:r.rowCount||0};
  }
  return{success:false,statusCode:400,message:"Unsupported security action."};
}

async function adminUserAction(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const b=await body(req),userId=clean(b.userId||b.user_id),action=clean(b.action).toLowerCase();
  if(!userId||!["suspend","activate"].includes(action))return{success:false,statusCode:400,message:"Invalid user action."};
  const status=action==="suspend"?"suspended":"active";
  const r=await db(`UPDATE users SET status=$1,updated_at=NOW() WHERE user_id=$2 RETURNING user_id,status`,[status,userId]);
  if(!r.rows.length)return{success:false,statusCode:404,message:"User not found."};
  await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
    [admin.id,action,"user",userId,JSON.stringify({status}),requestIp(req)]);
  return{success:true,user:r.rows[0]};
}

async function adminWalletAdjust(req,mode){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const b=await body(req),userId=clean(b.userId||b.user_id),amount=Number(b.amount),reason=clean(b.reason)||`Admin ${mode}`;
  if(!userId||!validAmount(amount))return{success:false,statusCode:400,message:"Valid user ID and amount are required."};
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const u=await client.query(`SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE`,[userId]);
    if(!u.rows.length){await client.query("ROLLBACK");return{success:false,statusCode:404,message:"User not found."};}
    await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);
    const w=await client.query(`SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE`,[userId]);
    const old=Number(w.rows[0].balance||0),delta=mode==="credit"?amount:-amount,next=old+delta;
    if(next<0){await client.query("ROLLBACK");return{success:false,statusCode:400,message:"Insufficient wallet balance."};}
    await client.query(`UPDATE wallets SET balance=$1,updated_at=NOW() WHERE user_id=$2`,[next,userId]);
    await client.query("COMMIT");
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [admin.id,`wallet_${mode}`,"user",userId,JSON.stringify({amount,reason,balance_after:next}),requestIp(req)]);
    return{success:true,message:"Wallet updated.",balance:next};
  }catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
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

const isAdminRoute = path === "/api/admin" || path.startsWith("/api/admin/");

if(isAdminRoute&&req.method!=="GET"&&req.method!=="HEAD"&&path!=="/api/admin/login"){
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


if(req.method==="GET"&&path==="/api/admin/wallet"){const result=await adminWalletInfo(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==="GET"&&path==="/api/admin/wallet/funding-account"){const result=await getAdminFlutterwaveFundingAccount(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==="POST"&&path==="/api/admin/wallet/funding-account"){const result=await createAdminFlutterwaveFundingAccount(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==='GET'&&path==='/api/admin/revenue'){const result=await adminRevenue(req,'summary');return send(res,result.success?200:(result.statusCode||400),result);}
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


/*
FLUTTERWAVE VIRTUAL ACCOUNT FUNDING
*/

if(req.method==="GET"&&path==="/api/funding-account"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
try{const result=await getFlutterwaveStaticFundingAccount(user);return send(res,200,result);}catch(error){console.error("FLUTTERWAVE ACCOUNT LOOKUP ERROR:",error);return send(res,502,{success:false,message:error.message||"Unable to load funding account."});}
}

if(req.method==="POST"&&path==="/api/funding-account/activate"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
try{const b=await body(req),accountType=String(b.accountType||"static").toLowerCase();let result;if(accountType==="dynamic")result=await createCustomerFlutterwaveDynamicAccount(user,Number(b.amount));else result=await createCustomerFlutterwaveStaticAccount(user,String(b.identityType||"").toLowerCase(),String(b.identityNumber||""));return send(res,200,result);}catch(error){console.error("FLUTTERWAVE FUNDING ACCOUNT ACTIVATION ERROR:",error);return send(res,400,{success:false,message:error.message||"Unable to create funding account."});}
}

if(req.method==="POST"&&path==="/api/flutterwave/webhook"){
let rawBody="";req.on("data",chunk=>{rawBody+=chunk;});req.on("end",async()=>{
try{
const directSignature=String(req.headers["verif-hash"]||"");
const hmacSignature=String(req.headers["flutterwave-signature"]||"");
let valid=false;
if(FLW_SECRET_HASH){
if(directSignature&&directSignature===FLW_SECRET_HASH)valid=true;
if(hmacSignature){const expected=crypto.createHmac("sha256",FLW_SECRET_HASH).update(rawBody).digest("base64");if(hmacSignature===expected)valid=true;}
}
if(!valid)return send(res,401,{success:false,message:"Invalid Flutterwave webhook signature."});
let payload;try{payload=JSON.parse(rawBody||"{}");}catch{return send(res,400,{success:false,message:"Invalid JSON payload."});}
const event=String(payload?.event||payload?.type||payload?.event_type||"").toLowerCase();
if(event==="charge.completed"||event==="account_transaction"||event==="bank_transfer_transaction"||payload?.["event.type"]==="BANK_TRANSFER_TRANSACTION"){
const result=await creditFlutterwaveVirtualAccount(payload);return send(res,200,{success:true,message:result.duplicate?"Webhook already processed.":"Flutterwave funding webhook processed.",...result});
}
if(event==="transfer.completed"||event==="transfer_completed"||payload?.["event.type"]==="Transfer"){
const d=payload?.data||payload?.transfer||{};const providerId=String(d.id||"");const referenceValue=clean(d.reference||d.tx_ref||"");const rawStatus=String(d.status||"").toUpperCase();const status=["SUCCESSFUL","COMPLETED"].includes(rawStatus)?"successful":(["FAILED","REVERSED","CANCELLED","CANCELED"].includes(rawStatus)?"failed":"processing");
let q;
if(providerId)q=await db(`SELECT * FROM admin_revenue_withdrawals WHERE provider_transfer_id=$1 LIMIT 1`,[providerId]);
if(!q||!q.rows.length)q=await db(`SELECT * FROM admin_revenue_withdrawals WHERE reference=$1 LIMIT 1`,[referenceValue]);
if(q.rows.length){const row=q.rows[0];if(status!==row.status){if(status==='failed')await reverseRevenueWithdrawal(row.admin_id,row.id,row.amount,d.complete_message||"Flutterwave transfer failed.");else await db(`UPDATE admin_revenue_withdrawals SET status=$1,provider_message=$2,updated_at=NOW(),completed_at=CASE WHEN $1='successful' THEN NOW() ELSE completed_at END WHERE id=$3`,[status,d.complete_message||status,row.id]);}return send(res,200,{success:true,withdrawalId:row.id,status});}
return send(res,200,{success:true,message:"Flutterwave transfer webhook received; no matching BOLTIV withdrawal was found."});
}
return send(res,200,{success:true,message:"Flutterwave webhook received."});
}catch(error){console.error("FLUTTERWAVE WEBHOOK ERROR:",error);return send(res,500,{success:false,message:error.message||"Webhook processing failed."});}
});return;
}

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

return send(res,410,{
success:false,
message:"Wallet funding is handled through Flutterwave virtual accounts."
});

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

if(req.method==="POST"&&path==="/api/vtu/data/plans"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
const b=await body(req);
const network=normalizeDataNetwork(b.network);
if(!network)return send(res,400,{success:false,message:"Unsupported network."});
try{
const rawPlans=await fetchCheapDataHubDataPlans(network);
const service=await getService("data");
if(!service)return send(res,503,{success:false,message:"Data service is not configured."});
if(service.enabled===false)return send(res,503,{success:false,message:"Data service is currently unavailable."});
if(service.maintenance===true)return send(res,503,{success:false,message:"Data service is currently under maintenance."});
const pricing=pricingConfig(service);
const byPlan=new Map();
for(const plan of rawPlans){
const bundleId=Number(plan.bundle_id||0), providerPrice=Number(plan.price||0);
if(!Number.isInteger(bundleId)||bundleId<=0||!Number.isFinite(providerPrice)||providerPrice<=0)continue;
const customerPrice=customerPriceFromCost(providerPrice,pricing);
if(customerPrice===null)continue;
byPlan.set(String(bundleId),{code:String(bundleId),bundle_id:bundleId,name:clean(plan.name||String(bundleId)),customer_price:customerPrice,provider_price:Number(providerPrice.toFixed(2)),network_name:network,service_id:null,size_mb:Number(plan.size_mb||0),validity_days:Number(plan.validity_days||0),duration:""});
}
const plans=Array.from(byPlan.values()).sort((a,b)=>Number(a.size_mb)-Number(b.size_mb)||Number(a.validity_days)-Number(b.validity_days)||Number(a.customer_price)-Number(b.customer_price)).slice(0,50);
return send(res,200,{success:true,network,plans});
}catch(error){console.error("CHEAPDATAHUB DATA PLAN CATALOG ERROR:",error?.stack||error?.message||error);return send(res,502,{success:false,message:"Unable to load CheapDataHub data plans right now."});}
}

/*
EXAM PIN CATALOG
*/

if(req.method==="GET"&&path==="/api/vtu/exam-pin/products"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
try{
const provider=await cheapDataHubGet("exam-pin/products");
if(!provider.success)return send(res,provider.statusCode>=500?502:400,{success:false,message:provider.message||"Unable to load exam PIN products."});
const service=await getService("exam_pin");
if(!service)return send(res,503,{success:false,message:"Exam PIN service is not configured."});
if(service.enabled===false)return send(res,503,{success:false,message:"Exam PIN service is currently unavailable."});
if(service.maintenance===true)return send(res,503,{success:false,message:"Exam PIN service is currently under maintenance."});
const pricing=pricingConfig(service);
const raw=Array.isArray(provider.data?.data)?provider.data.data:(Array.isArray(provider.data?.products)?provider.data.products:(Array.isArray(provider.data)?provider.data:[]));
const products=raw.map(p=>{const cost=Number(p.price??p.amount??p.cost??0);const price=customerPriceFromCost(cost,pricing);return {product_id:Number(p.product_id??p.id??0),name:clean(p.name??p.exam_name??p.title??"Exam PIN"),exam_name:clean(p.exam_name??p.name??""),provider_price:cost,customer_price:price};}).filter(p=>Number.isInteger(p.product_id)&&p.product_id>0&&p.provider_price>0&&p.customer_price>0&&p.name);
return send(res,200,{success:true,products});
}catch(error){console.error("EXAM PIN CATALOG ERROR:",error?.stack||error?.message||error);return send(res,502,{success:false,message:"Unable to load exam PIN products right now."});}
}

/*
VTU TRANSACTION
*/

if(
req.method==="POST"&&
["/api/vtu/purchase","/api/vtu/airtime","/api/vtu/data","/api/vtu/cable","/api/vtu/electricity","/api/vtu/exam-pin"].includes(path)
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
flutterwave:Boolean(FLW_SECRET_KEY),
vtu:Boolean((VTU_API_KEY&&VTU_API_BASE_URL)||(CHEAPDATAHUB_API_KEY&&CHEAPDATAHUB_API_BASE_URL)),
cheapdatahub:Boolean(CHEAPDATAHUB_API_KEY&&CHEAPDATAHUB_API_BASE_URL),
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
`Flutterwave configured: ${
FLW_SECRET_KEY?
"YES":
"NO"
}`
);

console.log(
`VTU configured: ${
(VTU_API_KEY&&VTU_API_BASE_URL)||(CHEAPDATAHUB_API_KEY&&CHEAPDATAHUB_API_BASE_URL)?
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

