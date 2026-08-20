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
const adminPricing=config.pricing&&typeof config.pricing==="object"?config.pricing:null;

/*
   ADMIN DASHBOARD PRICING FORMAT
   { pricing: { mode: "discount"|"fixed", discount_pct, fixed_profit } }

   Keep support for the older markup format too, so existing services do not
   break when their configuration was saved by an older dashboard.
*/
if(adminPricing){
  let mode=clean(adminPricing.mode||"discount").toLowerCase();
  if(mode==="discount"||mode==="provider_discount")mode="provider_discount";
  else if(mode==="fixed"||mode==="fixed_profit")mode="fixed_profit";
  else mode="provider_discount";

  const discountPct=Number(adminPricing.discount_pct??adminPricing.discountPercent??0);
  const fixedProfit=Number(adminPricing.fixed_profit??adminPricing.fixedProfit??0);
  const serviceFee=Number(service?.fee||0);

  return {
    markup_mode:mode,
    markup_pct:Number.isFinite(discountPct)?Math.min(100,Math.max(0,discountPct)):0,
    markup_fixed:Number.isFinite(fixedProfit)?Math.max(0,fixedProfit):0,
    service_fee:Number.isFinite(serviceFee)?Math.max(0,serviceFee):0
  };
}

/* Legacy pricing configuration */
let mode=clean(config.markup_mode??config.markupMode??config.pricing_mode??config.pricingMode??"none").toLowerCase();
if(mode==="percent")mode="percentage";
if(mode==="fixed_amount")mode="fixed";
if(mode==="cost_plus")mode="percentage_plus_fixed";
const pct=Number(config.markup_pct??config.markupPercent??config.percentage??0);
const fixed=Number(config.markup_fixed??config.markupFixed??config.fixed??service?.fee??0);
return {
markup_mode:["none","percentage","fixed","percentage_plus_fixed"].includes(mode)?mode:"none",
markup_pct:Number.isFinite(pct)?Math.max(0,pct):0,
markup_fixed:Number.isFinite(fixed)?Math.max(0,fixed):0,
service_fee:0
};
}

function customerPriceFromCost(cost,pricing){
const n=Number(cost);
if(!Number.isFinite(n)||n<=0)return null;
const p=pricing||{};
let price=n;

/* Current Admin Dashboard pricing */
if(p.markup_mode==="provider_discount"){
  price=n*(1-Number(p.markup_pct||0)/100);
  price+=Number(p.markup_fixed||0);
  price+=Number(p.service_fee||0);
}
else if(p.markup_mode==="fixed_profit"){
  price=n+Number(p.markup_fixed||0)+Number(p.service_fee||0);
}
/* Legacy pricing */
else if(p.markup_mode==="fixed")price+=Number(p.markup_fixed||0);
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

const cheapDataHubPlanCache=new Map();
async function getAuthoritativeCheapDataHubDataPlan(network,bundleId){
const selected=normalizeDataNetwork(network);
const id=Number(bundleId);
if(!selected||!Number.isInteger(id)||id<=0)throw new Error("Invalid data plan.");
const key=selected;
let entry=cheapDataHubPlanCache.get(key);
if(!entry||Date.now()-entry.at>60000){
  entry={at:Date.now(),plans:await fetchCheapDataHubDataPlans(selected)};
  cheapDataHubPlanCache.set(key,entry);
}
const plan=entry.plans.find(x=>Number(x.bundle_id)===id);
if(!plan)throw new Error("The selected data plan is no longer available.");
const service=await getService("data");
if(!service||service.enabled===false||service.maintenance===true)throw new Error("Data service is currently unavailable.");
const customerPrice=customerPriceFromCost(Number(plan.price),pricingConfig(service));
if(!Number.isFinite(customerPrice)||customerPrice<=0)throw new Error("Unable to determine the current data price.");
return {...plan,provider_price:Number(plan.price),customer_price:customerPrice};
}

async function getAuthoritativeCheapDataHubExamProduct(productId){
const id=Number(productId);
if(!Number.isInteger(id)||id<=0)throw new Error("Invalid exam PIN product.");
const provider=await cheapDataHubGet("exam-pin/products");
if(!provider.success)throw new Error(provider.message||"Unable to verify exam PIN pricing.");
const service=await getService("exam_pin");
if(!service||service.enabled===false||service.maintenance===true)throw new Error("Exam PIN service is currently unavailable.");
const raw=Array.isArray(provider.data?.data)?provider.data.data:(Array.isArray(provider.data?.products)?provider.data.products:(Array.isArray(provider.data)?provider.data:[]));
const found=raw.find(p=>Number(p.product_id??p.id)===id);
if(!found)throw new Error("The selected exam PIN product is no longer available.");
const providerPrice=Number(found.price??found.amount??found.cost??0);
const customerPrice=customerPriceFromCost(providerPrice,pricingConfig(service));
if(!Number.isFinite(providerPrice)||providerPrice<=0||!Number.isFinite(customerPrice)||customerPrice<=0)throw new Error("Unable to determine the current exam PIN price.");
return {product_id:id,provider_price:providerPrice,customer_price:customerPrice,name:clean(found.name??found.exam_name??found.title??"Exam PIN")};
}

async function cheapDataHubRequest(endpoint,payload,options={}){
if(!CHEAPDATAHUB_API_KEY)return {success:false,outcome:"unavailable",statusCode:503,message:"CheapDataHub is not configured on the server."};
const timeoutMs=Number(options.timeoutMs||15000);
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),timeoutMs);
try{
const response=await fetch(`${CHEAPDATAHUB_API_BASE_URL}/${endpoint.replace(/^\/+/,"")}/`,{
method:"POST",
headers:{Authorization:`Bearer ${CHEAPDATAHUB_API_KEY}`,"Content-Type":"application/json",Accept:"application/json"},
body:JSON.stringify(payload),signal:controller.signal
});
let data={};try{data=await response.json();}catch{}
const statusValue=String(data.status??data.success??data.data?.status??"").toLowerCase();
const providerReference=data.reference||data.transaction_id||data.data?.reference||data.data?.transaction_id||null;
if(["true","success","successful"].includes(statusValue))return {success:true,outcome:"successful",statusCode:response.status,data,providerReference,message:data.message||"Transaction successful."};
if(["pending","processing","initiated"].includes(statusValue))return {success:true,outcome:"pending",statusCode:response.status,data,providerReference,message:data.message||"Transaction is being processed."};
if(statusValue==="failed")return {success:false,outcome:"failed",statusCode:response.status,data,providerReference,message:data.message||"Transaction failed."};
if(statusValue==="refunded")return {success:false,outcome:"refunded",statusCode:response.status,data,providerReference,message:data.message||"Transaction was refunded by the provider."};
if(response.status===409)return {success:false,outcome:"duplicate_unknown",statusCode:409,data,providerReference,message:data.message||"Provider reports an existing transaction; status verification is required."};
if(response.status>=500)return {success:false,outcome:"unknown",statusCode:response.status,data,providerReference,message:data.message||`CheapDataHub server error (${response.status}); transaction status must be verified.`};
return {success:false,outcome:"failed",statusCode:response.status,data,providerReference,message:data.message||`CheapDataHub request failed (${response.status}).`};
}catch(e){
if(e.name==="AbortError")return {success:false,outcome:"unknown",statusCode:504,data:{},providerReference:null,message:"CheapDataHub did not respond in time. Your transaction is being verified."};
return {success:false,outcome:"unknown",statusCode:502,data:{},providerReference:null,message:"CheapDataHub connection could not be confirmed. Your transaction is being verified."};
}finally{clearTimeout(timer);}
}

async function cheapDataHubGet(endpoint,options={}){
if(!CHEAPDATAHUB_API_KEY)return {success:false,outcome:"unavailable",statusCode:503,message:"CheapDataHub is not configured on the server."};
const timeoutMs=Number(options.timeoutMs||10000);
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),timeoutMs);
try{
const response=await fetch(`${CHEAPDATAHUB_API_BASE_URL}/${endpoint.replace(/^\/+/,"")}/`,{method:"GET",headers:{Authorization:`Bearer ${CHEAPDATAHUB_API_KEY}`,Accept:"application/json"},signal:controller.signal});
let data={};try{data=await response.json();}catch{}
const statusValue=String(data.status??data.success??data.data?.status??data.transaction?.status??"").toLowerCase();
const success=["true","success","successful"].includes(statusValue);
return {success,outcome:success?"successful":(["pending","processing","initiated"].includes(statusValue)?"pending":(statusValue==="failed"?"failed":(statusValue==="refunded"?"refunded":"unknown"))),statusCode:response.status,data,message:data.message||data.error||(!response.ok?`CheapDataHub request failed (${response.status}).`:success?"Request successful.":"Request status is unknown.")};
}catch(e){return {success:false,outcome:"unknown",statusCode:e.name==="AbortError"?504:502,message:"CheapDataHub status could not be verified."};}finally{clearTimeout(timer);}
}

async function debitWallet(userId,amount){
const client=await pool.connect();
try{await client.query("BEGIN");await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);const r=await client.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[amount,userId]);if(!r.rows.length){await client.query("ROLLBACK");return {success:false,message:"Insufficient wallet balance."};}await client.query("COMMIT");return {success:true,balance:Number(r.rows[0].balance)};}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

async function createVTUTransactionAndDebit(data){
const client=await pool.connect();
try{
await client.query("BEGIN");
await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[data.userId]);
if(data.idempotencyKey){
const existing=await client.query(`SELECT id,reference,status,amount,provider_reference FROM transactions WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1 FOR UPDATE`,[data.userId,data.idempotencyKey]);
if(existing.rows.length){await client.query("COMMIT");return {success:true,existing:true,transaction:existing.rows[0]};}
}
const wallet=await client.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[data.amount,data.userId]);
if(!wallet.rows.length){await client.query("ROLLBACK");return {success:false,message:"Insufficient wallet balance."};}
await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:data.userId,direction:"debit",amount:-Number(data.amount),balanceAfter:Number(wallet.rows[0].balance),reference:`WALLET-DEBIT-${data.reference}`,category:"vtu_debit",description:`Wallet debit for ${data.service}`,metadata:{service:data.service,recipient:data.recipient||null}});
let inserted;
try{
inserted=await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,recipient,metadata,idempotency_key,provider_reference) VALUES($1,'debit',$2,$3,$4,'processing',$5,$6::jsonb,$7,$8) RETURNING id,reference,status,amount,provider_reference`,[data.userId,data.service,data.amount,data.reference,data.recipient||null,JSON.stringify(data.metadata||{}),data.idempotencyKey||null,data.providerReference||null]);
await client.query(`UPDATE financial_ledger SET transaction_id=$1 WHERE reference=$2`,[inserted.rows[0].id,`WALLET-DEBIT-${data.reference}`]);
}catch(e){
if(e.code==="23505"&&data.idempotencyKey){const existing=await client.query(`SELECT id,reference,status,amount,provider_reference FROM transactions WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1 FOR UPDATE`,[data.userId,data.idempotencyKey]);if(existing.rows.length){await client.query("ROLLBACK");return {success:true,existing:true,transaction:existing.rows[0]};}}
throw e;
}
await client.query("COMMIT");
return {success:true,existing:false,transaction:inserted.rows[0],balance:Number(wallet.rows[0].balance)};
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

async function finalizeVTUTransaction(transactionId,outcome,providerData={},providerReference=null){
const client=await pool.connect();
try{
await client.query("BEGIN");
const q=await client.query(`SELECT * FROM transactions WHERE id=$1 FOR UPDATE`,[transactionId]);
if(!q.rows.length){await client.query("ROLLBACK");return {success:false,message:"Transaction not found."};}
const tx=q.rows[0];
const ref=providerReference||tx.provider_reference||providerData.reference||providerData.transaction_id||providerData.data?.reference||providerData.data?.transaction_id||null;
if(tx.status==="successful"){await client.query("COMMIT");return {success:true,status:"successful",alreadyFinal:true};}
if(tx.status==="refunded"){await client.query("COMMIT");return {success:true,status:"refunded",alreadyFinal:true};}
if(outcome==="successful"){
await client.query(`UPDATE transactions SET status='successful',provider_reference=COALESCE(provider_reference,$2),completed_at=NOW(),last_provider_status='successful',metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[transactionId,ref,JSON.stringify({provider_response:providerData})]);
const fresh=(await client.query(`SELECT * FROM transactions WHERE id=$1`,[transactionId])).rows[0];
await recordRevenueSale(client,fresh);
await client.query("COMMIT");
// Notifications are created after the transaction commit so a notification
// failure can never roll back a successful customer purchase.
try{
  const meta=fresh.metadata&&typeof fresh.metadata==="object"?fresh.metadata:{};
  let detail=`Your ${String(fresh.service||"service")} purchase of ₦${Number(fresh.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
  if(String(fresh.service).toLowerCase()==="data"){
    const network=clean(meta.network||meta.network_provider||"");
    const plan=clean(meta.plan||meta.plan_name||"");
    if(network||plan)detail=`Your ${network||"Data"} ${plan||"data plan"} purchase of ₦${Number(fresh.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
  }
  await addNotificationOnce(fresh.user_id,"Transaction successful",detail,"transaction",`tx-success-${fresh.id}`);
}catch(error){console.error("TRANSACTION NOTIFICATION ERROR:",error?.stack||error?.message||error);}
return {success:true,status:"successful"};
}
if(outcome==="failed"||outcome==="refunded"){
if(!tx.refunded_at){
const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[Number(tx.amount),tx.user_id]);
if(!wr.rows.length)throw new Error("Wallet could not be credited for refund.");
await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:tx.user_id,direction:"credit",amount:Number(tx.amount),balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-REFUND-${tx.reference}`,transactionId:tx.id,category:"vtu_refund",description:`Refund for ${tx.service}`,metadata:{reason:outcome}});
}
await client.query(`UPDATE transactions SET status='refunded',provider_reference=COALESCE(provider_reference,$2),refunded_at=COALESCE(refunded_at,NOW()),completed_at=COALESCE(completed_at,NOW()),last_provider_status=$4,refund_reason=$5,metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[transactionId,ref,JSON.stringify({provider_response:providerData,refund_reason:outcome}),outcome,outcome]);
const fresh=(await client.query(`SELECT * FROM transactions WHERE id=$1`,[transactionId])).rows[0];
if(!tx.refunded_at)await recordRevenueRefund(client,fresh);
await client.query("COMMIT");if(!tx.refunded_at){try{await addNotificationOnce(tx.user_id,"Transaction refunded",`Your ${String(tx.service||"service")} transaction of ₦${Number(tx.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} could not be completed. The amount has been returned to your wallet.` ,"transaction",`tx-refund-${tx.id}`);}catch{}}return {success:true,status:"refunded",refunded:!tx.refunded_at};
}
await client.query(`UPDATE transactions SET status='pending',provider_reference=COALESCE(provider_reference,$2),last_provider_status='pending',metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[transactionId,ref,JSON.stringify({provider_response:providerData})]);
await client.query("COMMIT");return {success:true,status:"pending"};
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

async function refundWallet(userId,amount){
await db(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2`,[amount,userId]);
}

async function insertVTUTransaction(data){
await db(`INSERT INTO transactions(user_id,type,service,amount,reference,status,recipient,metadata,idempotency_key,provider_reference,completed_at,refunded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT(reference) DO NOTHING`,[data.userId,data.type||"debit",data.service,data.amount,data.reference,data.status,data.recipient||null,JSON.stringify(data.metadata||{}),data.idempotencyKey||null,data.providerReference||null,data.status==="successful"?new Date():null,data.status==="failed"?new Date():null]);
}

async function getCheapDataHubTransaction(providerReference){
if(!providerReference)return {success:false,outcome:"unknown",message:"Missing provider reference."};
return cheapDataHubGet(`transactions/${encodeURIComponent(providerReference)}`);
}

async function reconcileCheapDataHubTransactions(){
let rows=[];
try{rows=(await db(`SELECT id,provider_reference FROM transactions WHERE service IN ('airtime','data','exam_pin') AND status IN ('processing','pending') AND provider_reference IS NOT NULL AND date>NOW()-INTERVAL '48 hours' ORDER BY date ASC LIMIT 100`)).rows;}catch(e){console.error("CHEAPDATAHUB RECONCILIATION QUERY ERROR:",e);return {success:false,error:e.message};}
let checked=0,finalized=0;
for(const tx of rows){
try{const result=await getCheapDataHubTransaction(tx.provider_reference);checked++;if(["successful","failed","refunded"].includes(result.outcome)){await finalizeVTUTransaction(tx.id,result.outcome,result.data||{},tx.provider_reference);finalized++;}}catch(e){console.error("CHEAPDATAHUB RECONCILIATION ERROR:",tx.id,e);}}
return {success:true,checked,finalized};
}

async function reconcilePendingTransactions(){return reconcileCheapDataHubTransactions();}

async function adminRefund(req){
const check=await requireAdminCsrf(req);if(!check.success)return check;
const b=await body(req);const ref=clean(b.reference);const reason=clean(b.reason)||"Admin approved refund";
if(!ref)return {success:false,statusCode:400,message:"Transaction reference is required."};
const client=await pool.connect();
try{await client.query("BEGIN");const q=await client.query(`SELECT * FROM transactions WHERE reference=$1 FOR UPDATE`,[ref]);if(!q.rows.length){await client.query("ROLLBACK");return {success:false,statusCode:404,message:"Transaction not found."};}const tx=q.rows[0];if(tx.type!=="debit"){await client.query("ROLLBACK");return {success:false,statusCode:400,message:"Only debit transactions can be refunded."};}if(tx.status==="successful"||tx.status==="pending"||tx.status==="processing"){if(!tx.refunded_at){const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[Number(tx.amount),tx.user_id]);if(!wr.rows.length)throw new Error("Wallet could not be credited.");await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:tx.user_id,direction:"credit",amount:Number(tx.amount),balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-ADMIN-REFUND-${tx.reference}`,transactionId:tx.id,category:"admin_refund",description:`Admin refund for ${tx.service}`,metadata:{reason,admin_id:check.admin.id}});await recordRevenueRefund(client,tx);}await client.query(`UPDATE transactions SET status='refunded',refunded_at=COALESCE(refunded_at,NOW()),completed_at=COALESCE(completed_at,NOW()),metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[tx.id,JSON.stringify({admin_refund:true,reason,admin_id:check.admin.id})]);}else if(tx.status==="refunded"){await client.query("COMMIT");return {success:true,alreadyRefunded:true,message:"Transaction was already refunded."};}else{await client.query("ROLLBACK");return {success:false,statusCode:400,message:"This transaction cannot be refunded in its current state."};}await client.query("COMMIT");return {success:true,message:"Transaction refunded successfully."};}catch(e){try{await client.query("ROLLBACK")}catch{};return {success:false,statusCode:500,message:"Refund failed."};}finally{client.release();}
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
const security=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[userId]);
if(!security.rows[0]?.transaction_pin_hash)return {success:false,statusCode:400,message:"Please set your Transaction PIN before making a purchase."};
const suppliedPin=String(data.transactionPin||"");
if(!/^\d{4}$/.test(suppliedPin)||!verifyPassword(suppliedPin,security.rows[0].transaction_pin_hash))return {success:false,statusCode:400,message:"Incorrect Transaction PIN."};
let providerPayload,recipient=clean(data.phone),pricingMeta={providerCost:null,customerPrice:amount,grossProfit:0};
if(service==="data"){
const bundleId=Number(data.bundle_id||data.providerPayload?.bundle_id||0);if(!Number.isInteger(bundleId)||bundleId<=0)return {success:false,statusCode:400,message:"Invalid data plan."};
let authoritative;try{authoritative=await getAuthoritativeCheapDataHubDataPlan(data.network||data.providerPayload?.network,bundleId);}catch(e){return {success:false,statusCode:503,message:e.message||"Unable to verify the current data plan price."};}
if(Math.abs(Number(amount)-Number(authoritative.customer_price))>0.009)return {success:false,statusCode:400,message:"The selected data plan price has changed. Please refresh the plans and try again."};
pricingMeta={providerCost:Number(authoritative.provider_price),customerPrice:Number(authoritative.customer_price),grossProfit:Number((authoritative.customer_price-authoritative.provider_price).toFixed(2))};
providerPayload={bundle_id:bundleId,phone_number:recipient};
// Persist human-readable purchase details so receipts, transaction history,
// and notifications can render the same information returned to the customer.
pricingMeta.network=authoritative.network_name||normalizeDataNetwork(data.network||data.providerPayload?.network);
pricingMeta.plan=clean(authoritative.name||data.plan_name||data.plan||data.providerPayload?.plan_name||data.providerPayload?.plan||String(bundleId));

}else if(service==="exam_pin"){
const productId=Number(data.product_id||data.providerPayload?.product_id||0);const quantity=Number(data.quantity||data.providerPayload?.quantity||1);if(!Number.isInteger(productId)||productId<=0)return {success:false,statusCode:400,message:"Invalid exam PIN product."};if(![1,2,5].includes(quantity))return {success:false,statusCode:400,message:"Exam PIN quantity must be 1, 2, or 5."};
let authoritative;try{authoritative=await getAuthoritativeCheapDataHubExamProduct(productId);}catch(e){return {success:false,statusCode:503,message:e.message||"Unable to verify the current exam PIN price."};}
const expectedTotal=Number((authoritative.customer_price*quantity).toFixed(2));
if(Math.abs(Number(amount)-expectedTotal)>0.009)return {success:false,statusCode:400,message:"The selected exam PIN price has changed. Please refresh the products and try again."};
pricingMeta={providerCost:Number((authoritative.provider_price*quantity).toFixed(2)),customerPrice:expectedTotal,grossProfit:Number((expectedTotal-authoritative.provider_price*quantity).toFixed(2))};
providerPayload={product_id:productId,quantity};recipient=null;
}else{
const network=normalizeDataNetwork(data.network||data.providerPayload?.network);const providerIds={MTN:1,GLO:2,AIRTEL:3,"9MOBILE":4};const providerId=providerIds[network];if(!providerId)return {success:false,statusCode:400,message:"Unsupported network."};providerPayload={provider_id:providerId,phone_number:recipient,amount};
}
const referenceValue=reference("BOLTIV-TX");
const reserved=await createVTUTransactionAndDebit({userId,service,amount,reference:referenceValue,recipient,idempotencyKey:idem,metadata:{provider:"cheapdatahub",request:providerPayload,pricing:pricingMeta}});
if(!reserved.success)return {success:false,statusCode:400,message:reserved.message,balance:0};
if(reserved.existing){const t=reserved.transaction;const wallet=await getWallet(userId);return {success:t.status==="successful"||t.status==="pending"||t.status==="processing",message:t.status==="successful"?"Transaction already completed.":"Transaction is already being processed.",reference:t.reference,status:t.status,amount:Number(t.amount),providerReference:t.provider_reference,balance:wallet?.balance??0,alreadyProcessed:true};}
let providerResult;
try{providerResult=await cheapDataHubRequest(service==="data"?"data/purchase":service==="exam_pin"?"exam-pin/purchase":"airtime/purchase",providerPayload);}catch(e){providerResult={success:false,outcome:"unknown",statusCode:502,message:"CheapDataHub connection could not be confirmed. Your transaction is being verified."};}
const providerData=providerResult.data||{};const providerReference=providerResult.providerReference||providerData.reference||providerData.transaction_id||providerData.data?.reference||providerData.data?.transaction_id||null;
const finalized=await finalizeVTUTransaction(reserved.transaction.id,providerResult.outcome||"unknown",providerData,providerReference);
const wallet=await getWallet(userId);
if(finalized.status==="refunded")return {success:false,statusCode:providerResult.statusCode>=500?502:400,message:providerResult.message||"Transaction failed. Your wallet has been refunded.",reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??0,status:"refunded"};
return {success:true,status:finalized.status,message:providerResult.message||(finalized.status==="pending"?"Your transaction is being processed.":"Transaction successful."),reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??reserved.balance,providerData,delivery:providerData?.data?.delivery||providerData?.delivery||null,pins:providerData?.data?.delivery?.pins||providerData?.delivery?.pins||[]};
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
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_reason TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS last_provider_status TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_attempts INTEGER NOT NULL DEFAULT 0`);
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
await db(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS transaction_reference TEXT`);
await db(`CREATE INDEX IF NOT EXISTS support_tickets_transaction_ref_idx ON support_tickets(transaction_reference) WHERE transaction_reference IS NOT NULL`);

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
await db(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT`);
await db(`CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL`);

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
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS email TEXT`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2) DEFAULT 0`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_kobo BIGINT DEFAULT 0`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS credited BOOLEAN DEFAULT FALSE`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ`);
await db(`UPDATE payments p SET email=COALESCE(NULLIF(p.email,''),u.email) FROM users u WHERE u.user_id=p.user_id AND (p.email IS NULL OR p.email='')`);
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

await db(`CREATE TABLE IF NOT EXISTS financial_ledger( id BIGSERIAL PRIMARY KEY, account_type TEXT NOT NULL, owner_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('credit','debit','opening')), amount NUMERIC(14,2) NOT NULL, balance_after NUMERIC(14,2) NOT NULL, reference TEXT UNIQUE NOT NULL, transaction_id BIGINT, category TEXT NOT NULL, description TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_account_idx ON financial_ledger(account_type,owner_id,created_at DESC)`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_transaction_idx ON financial_ledger(transaction_id)`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_category_idx ON financial_ledger(category,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS platform_alerts( id BIGSERIAL PRIMARY KEY, alert_key TEXT UNIQUE NOT NULL, severity TEXT NOT NULL DEFAULT 'warning', title TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', details JSONB NOT NULL DEFAULT '{}'::jsonb, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ, email_sent_at TIMESTAMPTZ)`);
await db(`CREATE INDEX IF NOT EXISTS platform_alerts_status_idx ON platform_alerts(status,last_seen_at DESC)`);
await db(`ALTER TABLE platform_alerts ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ`);
await db(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,category,description) SELECT 'customer_wallet',w.user_id,'opening',w.balance,w.balance,'OPENING-CUSTOMER-'||w.user_id,'opening_balance','Opening balance at Phase 3 ledger activation' FROM wallets w WHERE NOT EXISTS(SELECT 1 FROM financial_ledger f WHERE f.account_type='customer_wallet' AND f.owner_id=w.user_id)`);
await db(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,category,description) SELECT 'admin_wallet',a.admin_id,'opening',a.balance,a.balance,'OPENING-ADMIN-'||a.admin_id,'opening_balance','Opening admin operating wallet balance' FROM admin_wallets a WHERE NOT EXISTS(SELECT 1 FROM financial_ledger f WHERE f.account_type='admin_wallet' AND f.owner_id=a.admin_id::text)`);
await db(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,category,description) SELECT 'revenue_wallet',a.admin_id,'opening',a.balance,a.balance,'OPENING-REVENUE-'||a.admin_id,'opening_balance','Opening BOLTIV revenue wallet balance' FROM admin_revenue_wallets a WHERE NOT EXISTS(SELECT 1 FROM financial_ledger f WHERE f.account_type='revenue_wallet' AND f.owner_id=a.admin_id::text)`);

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

async function addNotification(userId,title,message,type="info"){
  const uid=clean(userId),t=clean(title),m=clean(message),k=clean(type)||"info";
  if(!uid||!t||!m)return false;
  await db(`INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4)`,[uid,t,m,k]);
  return true;
}
async function addNotificationOnce(userId,title,message,type="info",dedupeKey=""){
  const uid=clean(userId),t=clean(title),m=clean(message),k=clean(type)||"info";
  if(!uid||!t||!m)return false;
  if(dedupeKey){const r=await db(`INSERT INTO notifications(user_id,title,message,type,dedupe_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[uid,t,m,k,clean(dedupeKey)]);return Boolean(r.rows.length);}
  return addNotification(uid,t,m,k);
}
async function adminNotifications(req){
  const admin=await adminFromToken(req); if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const b=await body(req),recipient=clean(b.recipient||"all").toLowerCase(),title=clean(b.title),message=clean(b.message),type=clean(b.type||"general");
  if(title.length<2||message.length<2)return{success:false,statusCode:400,message:"Notification title and message are required."};
  let userIds=[];
  if(recipient==="selected"){
    const id=clean(b.userId||b.user_id); if(!id)return{success:false,statusCode:400,message:"Select a user."};
    const u=await db(`SELECT user_id FROM users WHERE user_id=$1 LIMIT 1`,[id]); if(!u.rows.length)return{success:false,statusCode:404,message:"User not found."}; userIds=[u.rows[0].user_id];
  }else{userIds=(await db(`SELECT user_id FROM users WHERE status='active' ORDER BY created_at ASC`)).rows.map(x=>x.user_id);}
  if(!userIds.length)return{success:false,statusCode:400,message:"No eligible users found."};
  const client=await pool.connect(); try{await client.query("BEGIN");for(const uid of userIds)await client.query(`INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4)`,[uid,title,message,type]);await client.query("COMMIT");try{await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'notification_send','user','broadcast',$2::jsonb,$3)`,[admin.id,JSON.stringify({recipient,count:userIds.length,title,type}),requestIp(req)]);}catch{}return{success:true,sent:userIds.length,message:`Notification sent to ${userIds.length} user(s).`};}catch(e){try{await client.query("ROLLBACK")}catch{}throw e;}finally{client.release();}
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


/* ===================== PHASE 3 FINANCIAL LEDGER ===================== */
async function addFinancialLedger(client,{accountType,ownerId,direction,amount,balanceAfter,reference,transactionId=null,category,description,metadata={}}){
  await client.query(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,transaction_id,category,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(reference) DO NOTHING`,[String(accountType),String(ownerId),String(direction),Number(amount),Number(balanceAfter),String(reference),transactionId||null,String(category),String(description),JSON.stringify(metadata||{})]);
}

/* ===================== ADMIN WALLET / REVENUE HELPERS ===================== */
async function ensureAdminWallet(client,adminId){
  await client.query(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);
}
async function addAdminLedger(client,adminId,type,amount,balanceAfter,description,ref){
  await client.query(`INSERT INTO admin_wallet_ledger(admin_id,type,amount,balance_after,reference,description) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(reference) DO NOTHING`,[adminId,type,Number(amount),Number(balanceAfter),String(ref),String(description)]);
  await addFinancialLedger(client,{accountType:"admin_wallet",ownerId:String(adminId),direction:Number(amount)>=0?"credit":"debit",amount:Number(amount),balanceAfter:Number(balanceAfter),reference:`FIN-${ref}`,category:type,description,metadata:{source:"admin_wallet"}});
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
  await addFinancialLedger(client,{accountType:"revenue_wallet",ownerId:String(adminId),direction:Number(amount)>=0?"credit":"debit",amount:Number(amount),balanceAfter:Number(balanceAfter),reference:`FIN-${ref}`,category:type,description,metadata:{source:"revenue_wallet"}});
}

async function getPrimaryAdminId(client){
  const r=await client.query(`SELECT id FROM admins WHERE LOWER(email)=LOWER($1) LIMIT 1`,[ADMIN_EMAIL]);
  if(r.rows[0]?.id)return Number(r.rows[0].id);
  const fallback=await client.query(`SELECT id FROM admins ORDER BY id ASC LIMIT 1`);
  return fallback.rows[0]?.id?Number(fallback.rows[0].id):null;
}

async function recordRevenueSale(client,tx){
  const adminId=await getPrimaryAdminId(client);
  if(!adminId)return false;
  await ensureAdminRevenueWallet(client,adminId);
  const saleRef=`SALE-${tx.reference}`;
  const existing=await client.query(`SELECT id FROM admin_revenue_ledger WHERE reference=$1 LIMIT 1`,[saleRef]);
  if(existing.rows.length)return true;
  const w=await client.query(`UPDATE admin_revenue_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(tx.amount),adminId]);
  if(!w.rows.length)throw new Error("Revenue wallet could not be credited.");
  await addAdminRevenueLedger(client,adminId,"sale",Number(tx.amount),Number(w.rows[0].balance),`Customer ${tx.service} sale`,saleRef);
  return true;
}

async function recordRevenueRefund(client,tx){
  const adminId=await getPrimaryAdminId(client);
  if(!adminId)return false;
  const saleRef=`SALE-${tx.reference}`;
  const sale=await client.query(`SELECT id FROM admin_revenue_ledger WHERE reference=$1 LIMIT 1`,[saleRef]);
  if(!sale.rows.length)return false;
  const refundRef=`REFUND-${tx.reference}`;
  const existing=await client.query(`SELECT id FROM admin_revenue_ledger WHERE reference=$1 LIMIT 1`,[refundRef]);
  if(existing.rows.length)return true;
  await ensureAdminRevenueWallet(client,adminId);
  const w=await client.query(`UPDATE admin_revenue_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(tx.amount),adminId]);
  if(!w.rows.length)throw new Error("Revenue wallet could not be debited for refund.");
  await addAdminRevenueLedger(client,adminId,"refund",-Number(tx.amount),Number(w.rows[0].balance),`Refunded customer ${tx.service} sale`,refundRef);
  return true;
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
const userId=String(va.owner_id);await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[amount,userId]);if(!wr.rows.length)throw new Error("Wallet could not be credited.");const referenceValue=`FUND-${eventId}`;const tr=await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,provider_reference,metadata) VALUES($1,'credit','Wallet Funding',$2,$3,'successful',NOW(),$4,$5) ON CONFLICT(reference) DO NOTHING RETURNING id`,[userId,amount,referenceValue,txRef||txId,JSON.stringify({provider:"flutterwave",account_number:accountNumber||va.account_number,account_type:va.account_type,payload})]);await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:userId,direction:"credit",amount:Number(amount),balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-FUND-${eventId}`,transactionId:tr.rows[0]?.id||null,category:"wallet_funding",description:"Flutterwave wallet funding",metadata:{provider_reference:txRef||txId}});await client.query(`UPDATE flutterwave_webhook_events SET processed=TRUE,processed_at=NOW() WHERE event_id=$1`,[eventId]);await client.query("COMMIT");try{await addNotification(userId,"Wallet credited",`Your wallet was credited with ₦${amount.toLocaleString("en-NG",{minimumFractionDigits:2})} via Flutterwave bank transfer.` ,"payment");}catch{}return{success:true,duplicate:false,amount,userId};}catch(e){try{await client.query("ROLLBACK")}catch{}throw e;}finally{client.release();}
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

async function adminRevenue(req,action){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
if(action!=="summary")return{success:false,statusCode:404,message:"Revenue withdrawal is disabled in BOLTIV. Use the Flutterwave dashboard for withdrawals."};
await db(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
const w=(await db(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1`,[admin.id])).rows[0];
const r=(await db(`SELECT COALESCE(SUM(CASE WHEN type='sale' THEN amount ELSE 0 END),0) AS sales,COALESCE(SUM(CASE WHEN type='refund' THEN ABS(amount) ELSE 0 END),0) AS refunds FROM admin_revenue_ledger WHERE admin_id=$1`,[admin.id])).rows[0];
const gross=(await db(`SELECT COALESCE(SUM(CASE WHEN type='debit' AND status='successful' THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit FROM transactions`)).rows[0];
return{success:true,summary:{balance:Number(w?.balance||0),sales:Number(r?.sales||0),refunds:Number(r?.refunds||0),grossProfit:Number(gross?.gross_profit||0)},withdrawalsDisabled:true,withdrawalInstructions:"Withdrawals are handled directly in the Flutterwave dashboard."};
}
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

async function getFinancialReconciliation(){
const customer=(await db(`SELECT COALESCE(SUM(balance),0) balance FROM wallets`)).rows[0];
const customerLedger=(await db(`SELECT COALESCE(SUM(amount),0) balance FROM financial_ledger WHERE account_type='customer_wallet'`)).rows[0];
const admin=(await db(`SELECT COALESCE(SUM(balance),0) balance FROM admin_wallets`)).rows[0];
const adminLedger=(await db(`SELECT COALESCE(SUM(amount),0) balance FROM financial_ledger WHERE account_type='admin_wallet'`)).rows[0];
const revenue=(await db(`SELECT COALESCE(SUM(balance),0) balance FROM admin_revenue_wallets`)).rows[0];
const revenueLedger=(await db(`SELECT COALESCE(SUM(amount),0) balance FROM financial_ledger WHERE account_type='revenue_wallet'`)).rows[0];
const fundingTx=(await db(`SELECT COALESCE(SUM(amount) FILTER(WHERE type='credit' AND status='successful' AND service='Wallet Funding'),0) total FROM transactions`)).rows[0];
const fundingLedger=(await db(`SELECT COALESCE(SUM(amount) FILTER(WHERE category='wallet_funding'),0) total FROM financial_ledger WHERE account_type='customer_wallet'`)).rows[0];
const pending=(await db(`SELECT COUNT(*)::int count,COALESCE(SUM(amount),0) amount FROM transactions WHERE status IN ('pending','processing')`)).rows[0];
const out={customerWallet:Number(customer?.balance||0),customerLedger:Number(customerLedger?.balance||0),adminWallet:Number(admin?.balance||0),adminLedger:Number(adminLedger?.balance||0),revenueWallet:Number(revenue?.balance||0),revenueLedger:Number(revenueLedger?.balance||0),fundingTransactions:Number(fundingTx?.total||0),fundingLedger:Number(fundingLedger?.total||0),pendingCount:Number(pending?.count||0),pendingAmount:Number(pending?.amount||0)};
out.customerVariance=Number((out.customerWallet-out.customerLedger).toFixed(2));out.adminVariance=Number((out.adminWallet-out.adminLedger).toFixed(2));out.revenueVariance=Number((out.revenueWallet-out.revenueLedger).toFixed(2));out.fundingVariance=Number((out.fundingTransactions-out.fundingLedger).toFixed(2));out.ok=[out.customerVariance,out.adminVariance,out.revenueVariance,out.fundingVariance].every(v=>Math.abs(v)<0.01);return out;
}
async function upsertPlatformAlert(alertKey,severity,title,message,details={}){
const r=await db(`INSERT INTO platform_alerts(alert_key,severity,title,message,status,details) VALUES($1,$2,$3,$4,'open',$5::jsonb) ON CONFLICT(alert_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,message=EXCLUDED.message,status='open',details=EXCLUDED.details,last_seen_at=NOW(),resolved_at=NULL RETURNING *`,[alertKey,severity,title,message,JSON.stringify(details)]);
const row=r.rows[0];
if(row&&severity==='critical'&&RESEND_API_KEY&&ADMIN_EMAIL){
const last=row.email_sent_at?new Date(row.email_sent_at).getTime():0;
if(!last||Date.now()-last>3600000){try{await sendEmail({to:ADMIN_EMAIL,subject:`BOLTIV ALERT: ${title}`,html:`<h2>${title}</h2><p>${message}</p><pre>${JSON.stringify(details,null,2)}</pre>`});await db(`UPDATE platform_alerts SET email_sent_at=NOW() WHERE alert_key=$1`,[alertKey]);}catch(e){console.error('ALERT EMAIL ERROR',e.message)}}}
return true;
}
async function resolvePlatformAlert(key){await db(`UPDATE platform_alerts SET status='resolved',resolved_at=COALESCE(resolved_at,NOW()) WHERE alert_key=$1 AND status='open'`,[key]);}
async function runPlatformAlerts(){try{const r=await getFinancialReconciliation();const f=(await db(`SELECT COUNT(*) FILTER(WHERE status='failed' AND date>=NOW()-INTERVAL '1 hour')::int failed,COUNT(*) FILTER(WHERE date>=NOW()-INTERVAL '1 hour')::int total FROM transactions`)).rows[0]||{};const failed=Number(f.failed||0),total=Number(f.total||0);const checks=[['recon_customer',Math.abs(r.customerVariance)>=.01,'critical','Customer wallet reconciliation mismatch',`Customer wallet differs from ledger by ₦${Math.abs(r.customerVariance).toFixed(2)}.`,{variance:r.customerVariance}],['recon_admin',Math.abs(r.adminVariance)>=.01,'critical','Admin operating wallet mismatch',`Admin operating wallet differs from ledger by ₦${Math.abs(r.adminVariance).toFixed(2)}.`,{variance:r.adminVariance}],['recon_revenue',Math.abs(r.revenueVariance)>=.01,'critical','Revenue wallet reconciliation mismatch',`Revenue wallet differs from ledger by ₦${Math.abs(r.revenueVariance).toFixed(2)}.`,{variance:r.revenueVariance}],['recon_funding',Math.abs(r.fundingVariance)>=.01,'critical','Funding reconciliation mismatch',`Credited deposits differ from Wallet Funding transactions by ₦${Math.abs(r.fundingVariance).toFixed(2)}.`,{variance:r.fundingVariance}],['cheapdatahub_config',!CHEAPDATAHUB_API_KEY,'critical','CheapDataHub is not configured','The CheapDataHub API key is missing from the server environment.',{}],['high_failure_rate',total>=10 && failed/total>=0.2,'warning','High transaction failure rate',`${failed} of ${total} transactions failed in the last hour.`,{failed,total,rate:failed/total}],['stale_pending',r.pendingCount>0 && r.pendingAmount>0,'warning','Pending VTU transactions require attention',`${r.pendingCount} transactions worth ₦${r.pendingAmount.toFixed(2)} remain pending or processing.`,{count:r.pendingCount,amount:r.pendingAmount}]];for(const c of checks){if(c[1])await upsertPlatformAlert(c[0],c[2],c[3],c[4],c[5]);else await resolvePlatformAlert(c[0]);}return r;}catch(e){await upsertPlatformAlert('reconciliation_job','critical','Reconciliation job failed',e.message||'Automated reconciliation failed.',{});return null;}}
async function adminAlerts(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};
  if(action==='list'){
    try{const r=await db(`SELECT id,alert_key,severity,title,message,status,details,first_seen_at,last_seen_at,resolved_at FROM platform_alerts ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,last_seen_at DESC LIMIT 200`);return{success:true,alerts:r.rows};}
    catch(e){console.error('ADMIN ALERT LIST ERROR',e?.stack||e?.message||e);return{success:false,statusCode:500,message:'Unable to load platform alerts right now.'};}
  }
  if(action==='resolve'){const b=await body(req),key=clean(b.alertKey||b.alert_key);if(!key)return{success:false,statusCode:400,message:'Alert key is required.'};try{await resolvePlatformAlert(key);await adminAudit(admin,'alert_resolved','platform_alert',key,{},req);return{success:true};}catch(e){console.error('ADMIN ALERT RESOLVE ERROR',e?.stack||e?.message||e);return{success:false,statusCode:500,message:'Unable to resolve that alert.'};}}
  if(action==='reconcile'){
    try{const r=await runPlatformAlerts();if(!r)return{success:false,statusCode:500,message:'Reconciliation check failed. Check server logs for details.'};return{success:true,reconciliation:r};}
    catch(e){console.error('ADMIN ALERT RECONCILE ERROR',e?.stack||e?.message||e);return{success:false,statusCode:500,message:'Reconciliation check failed. Check server logs for details.'};}
  }
  return{success:false,statusCode:400,message:'Unsupported alert action.'};
}
async function adminAnalytics(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};const daily=(await db(`WITH d AS (SELECT generate_series(CURRENT_DATE-13,CURRENT_DATE,interval '1 day')::date day) SELECT d.day,COALESCE((SELECT COUNT(*) FROM users u WHERE u.created_at::date=d.day),0)::int users,COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.date::date=d.day),0)::int transactions,COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.date::date=d.day AND t.status='successful'),0)::int successful,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.date::date=d.day AND t.type='debit' AND t.status='successful'),0) sales,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.date::date=d.day AND t.type='credit' AND t.service='Wallet Funding' AND t.status='successful'),0) funding,COALESCE((SELECT SUM(ABS(t.amount)) FROM transactions t WHERE t.date::date=d.day AND t.status='refunded'),0) refunds,COALESCE((SELECT SUM(COALESCE((t.metadata->'pricing'->>'grossProfit')::numeric,0)) FROM transactions t WHERE t.date::date=d.day AND t.type='debit' AND t.status='successful'),0) profit FROM d ORDER BY d.day`)).rows;const services=(await db(`SELECT service,COUNT(*)::int transactions,COUNT(*) FILTER(WHERE status='successful')::int successful,COALESCE(SUM(amount) FILTER(WHERE status='successful' AND type='debit'),0) sales,COALESCE(SUM(COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0)) FILTER(WHERE status='successful' AND type='debit'),0) profit FROM transactions WHERE date>=NOW()-INTERVAL '30 days' GROUP BY service ORDER BY sales DESC`)).rows;const topUsers=(await db(`SELECT u.user_id,u.name,u.email,COUNT(t.id)::int transactions,COALESCE(SUM(t.amount) FILTER(WHERE t.type='debit' AND t.status='successful'),0) spend FROM users u JOIN transactions t ON t.user_id=u.user_id WHERE t.date>=NOW()-INTERVAL '30 days' GROUP BY u.user_id,u.name,u.email ORDER BY spend DESC LIMIT 10`)).rows;return{success:true,daily:daily.map(x=>({...x,sales:Number(x.sales||0),funding:Number(x.funding||0),refunds:Number(x.refunds||0),profit:Number(x.profit||0)})),services:services.map(x=>({...x,sales:Number(x.sales||0),profit:Number(x.profit||0)})),topUsers:topUsers.map(x=>({...x,spend:Number(x.spend||0)}))};}

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
  try{
    const r=await db(`SELECT p.id,p.reference,p.user_id,COALESCE(NULLIF(p.email,''),u.email,'') AS email,
      COALESCE(p.amount,0) AS amount,COALESCE(p.amount_kobo,0) AS amount_kobo,
      COALESCE(p.status,'pending') AS status,COALESCE(p.credited,FALSE) AS credited,
      COALESCE(p.created_at,NOW()) AS created_at,p.credited_at
      FROM payments p LEFT JOIN users u ON u.user_id=p.user_id
      ORDER BY p.created_at DESC NULLS LAST,p.id DESC LIMIT 1000`);
    return{success:true,payments:r.rows.map(x=>({...x,amount:Number(x.amount||0),amount_kobo:Number(x.amount_kobo||0),credited:Boolean(x.credited)}))};
  }catch(e){
    console.error('ADMIN PAYMENTS ERROR',e?.stack||e?.message||e);
    return{success:false,statusCode:500,message:'Unable to load payment history right now.'};
  }
}

async function adminMonitoring(req){
  const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const started=Date.now();let database="connected";try{await db("SELECT 1")}catch{database="unavailable"}
  let d={};try{d=(await db(`SELECT COUNT(*) FILTER (WHERE status IN ('processing','pending'))::int pending,COUNT(*) FILTER (WHERE status IN ('processing','pending') AND date<NOW()-INTERVAL '10 minutes')::int stale_pending,COUNT(*) FILTER (WHERE status='failed' AND date>=NOW()-INTERVAL '1 hour')::int failed_last_hour,COUNT(*) FILTER (WHERE status='successful' AND date>=NOW()-INTERVAL '24 hours')::int successful_last_24h,COUNT(*) FILTER (WHERE status IN ('failed','refunded') AND date>=NOW()-INTERVAL '24 hours')::int unsuccessful_last_24h,MAX(date) FILTER (WHERE status='successful') last_successful FROM transactions`)).rows[0]||{}}catch{return{success:false,statusCode:500,message:"Unable to load monitoring metrics."}}
  const total=Number(d.successful_last_24h||0)+Number(d.unsuccessful_last_24h||0);const rate=total?Math.round(Number(d.successful_last_24h||0)/total*1000)/10:100;
  return{success:true,monitoring:{database,cheapdatahub:Boolean(CHEAPDATAHUB_API_KEY&&CHEAPDATAHUB_API_BASE_URL),pending:Number(d.pending||0),stalePending:Number(d.stale_pending||0),failedLastHour:Number(d.failed_last_hour||0),successfulLast24h:Number(d.successful_last_24h||0),unsuccessfulLast24h:Number(d.unsuccessful_last_24h||0),successRate:rate,lastSuccessful:d.last_successful||null,responseMs:Date.now()-started,timestamp:new Date().toISOString()}};
}

async function adminSupport(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="list"){
    const r=await db(`SELECT t.id,t.user_id,t.subject,t.message,t.status,t.transaction_reference,t.created_at,t.updated_at,u.name,u.email
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
    const r=await db(`UPDATE support_tickets SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status,user_id`,[status,ticketId]);
    if(!r.rows.length)return{success:false,statusCode:404,message:"Support ticket not found."};
    try{await addNotification(r.rows[0].user_id,"Support ticket updated",`Ticket #${ticketId} is now ${status}.`,"support");}catch{}
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [admin.id,"support_status","ticket",String(ticketId),JSON.stringify({status}),requestIp(req)]);
    return{success:true,ticket:r.rows[0]};
  }
  if(action==="reply"){
    const message=clean(b.message);
    if(message.length<1)return{success:false,statusCode:400,message:"Reply message is required."};
    const t=await db(`SELECT id,user_id FROM support_tickets WHERE id=$1`,[ticketId]);
    if(!t.rows.length)return{success:false,statusCode:404,message:"Support ticket not found."};
    await db(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'admin',$2,$3)`,[ticketId,String(admin.id),message]);
    await db(`UPDATE support_tickets SET status='pending',updated_at=NOW() WHERE id=$1`,[ticketId]);
    try{await addNotification(t.rows[0].user_id,"Support replied",`There is a new reply on support ticket #${ticketId}.`,"support");}catch{}
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
    const adjRef=`ADMIN-${mode.toUpperCase()}-${reference("WALLET")}`;
    await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:userId,direction:delta>=0?"credit":"debit",amount:delta,balanceAfter:next,reference:adjRef,category:`admin_wallet_${mode}`,description:reason,metadata:{admin_id:admin.id}});
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
if(req.method==="POST"&&path==="/api/admin/wallet/fund/initialize"){const result=await initializeAdminWalletFunding(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/fund/verify"){const result=await verifyAdminWalletFunding(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/users/action"){const result=await adminUserAction(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/credit"){const result=await adminWalletAdjust(req,"credit");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/debit"){const result=await adminWalletAdjust(req,"debit");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/transactions/pending"){const admin=await requireAdmin(req); if(!admin)return; const result=await reconcilePendingTransactions(admin,req); return send(res,200,result);}
if(req.method==="POST"&&path==="/api/admin/transactions/refund"){const result=await adminRefund(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/notifications"){const result=await adminNotifications(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/monitoring"){const result=await adminMonitoring(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/analytics"){const result=await adminAnalytics(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/reconciliation"){const admin=await adminFromToken(req);if(!admin)return;const result=await getFinancialReconciliation();return send(res,200,{success:true,reconciliation:result});}
if(req.method==="GET"&&path==="/api/admin/ledger"){const admin=await adminFromToken(req);if(!admin)return;const r=await db(`SELECT id,account_type,owner_id,direction,amount,balance_after,reference,transaction_id,category,description,created_at FROM financial_ledger ORDER BY created_at DESC LIMIT 300`);return send(res,200,{success:true,ledger:r.rows.map(x=>({...x,amount:Number(x.amount||0),balance_after:Number(x.balance_after||0)}))});}
if(req.method==="GET"&&path==="/api/admin/alerts"){const result=await adminAlerts(req,"list");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/alerts/reconcile"){const result=await adminAlerts(req,"reconcile");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/alerts/resolve"){const result=await adminAlerts(req,"resolve");return send(res,result.success?200:(result.statusCode||400),result);}
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
// Backfill transaction notifications for successful purchases that may have
// completed before notification creation, or where a previous notification
// insert failed. This makes the notifications page self-healing.
try{
  const recent=await db(`SELECT id,user_id,service,amount,metadata FROM transactions WHERE user_id=$1 AND status='successful' AND type='debit' AND date>NOW()-INTERVAL '30 days' ORDER BY date DESC LIMIT 100`,[user.user_id]);
  for(const tx of recent.rows){
    const meta=tx.metadata&&typeof tx.metadata==="object"?tx.metadata:{};
    let message=`Your ${String(tx.service||"service")} purchase of ₦${Number(tx.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
    if(String(tx.service).toLowerCase()==="data"){
      const network=clean(meta.network||meta.network_provider||"");
      const plan=clean(meta.plan||meta.plan_name||"");
      if(network||plan)message=`Your ${network||"Data"} ${plan||"data plan"} purchase of ₦${Number(tx.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
    }
    await addNotificationOnce(user.user_id,"Transaction successful",message,"transaction",`tx-success-${tx.id}`);
  }
}catch(error){console.error("NOTIFICATION BACKFILL ERROR:",error?.stack||error?.message||error);}
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
const b=await body(req); const subject=clean(b.subject),message=clean(b.message),transactionReference=clean(b.transactionReference||b.reference); if(subject.length<3||message.length<5)return send(res,400,{success:false,message:"Please provide a subject and more details."});
const client=await pool.connect();
try{
await client.query("BEGIN");
const r=await client.query(`INSERT INTO support_tickets(user_id,subject,message,transaction_reference) VALUES($1,$2,$3,$4) RETURNING id,subject,message,status,transaction_reference,created_at`,[user.user_id,subject,message,transactionReference||null]);
await client.query(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'user',$2,$3)`,[r.rows[0].id,user.user_id,message]);
await client.query("COMMIT");
try{await addNotification(user.user_id,"Support request received",`Your support ticket #${r.rows[0].id} has been created. We will review it shortly.`,"support");}catch{}
return send(res,201,{success:true,ticket:r.rows[0],message:`Support ticket #${r.rows[0].id} created.`});
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}
if(req.method==="GET"&&path==="/api/support/tickets"){
const r=await db(`SELECT id,subject,message,status,transaction_reference,created_at,updated_at FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,[user.user_id]); return send(res,200,{success:true,tickets:r.rows});
}
if(req.method==="GET"&&path==="/api/support/ticket"){
const id=Number(url.searchParams.get("id")); if(!Number.isInteger(id)||id<1)return send(res,400,{success:false,message:"Invalid ticket."});
const t=await db(`SELECT id,subject,message,status,transaction_reference,created_at,updated_at FROM support_tickets WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,user.user_id]);
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
  const keys=['airtime','data','cable','electricity','exam_pin'];
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
setTimeout(()=>runPlatformAlerts().catch(e=>console.error("INITIAL ALERT CHECK ERROR",e)),5000).unref();
setInterval(()=>runPlatformAlerts().catch(e=>console.error("ALERT CHECK ERROR",e)),300000).unref();

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
const reconcileIntervalMs=Math.max(30000,Number(process.env.PENDING_RECONCILE_INTERVAL_MS||300000));
setTimeout(()=>reconcileCheapDataHubTransactions().catch(error=>console.error("INITIAL CHEAPDATAHUB RECONCILIATION ERROR:",error)),15000).unref();
setInterval(()=>{
  reconcileCheapDataHubTransactions().catch(error=>console.error("AUTOMATIC CHEAPDATAHUB RECONCILIATION ERROR:",error));
},reconcileIntervalMs).unref();

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

