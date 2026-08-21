/* BOLTIV API + TRANSACTION UI */

const API_URL="https://boltiv-backend.onrender.com";

const BoltivAPI={
    async request(endpoint,options={}){
        try{
            const res=await fetch(`${API_URL}${endpoint}`,{
                ...options,
                headers:{
                    "Content-Type":"application/json",
                    ...(options.headers||{})
                }
            });
            return await res.json();
        }catch(error){
            console.error("BOLTIV API ERROR:",error);
            return{success:false,message:"Unable to connect to BOLTIV server"};
        }
    },
    async health(){
        return await this.request("/api/health");
    }
};

const BoltivTransaction={
    overlay:null,

    init(){
        if(document.getElementById("boltivTransactionOverlay")){
            this.overlay=document.getElementById("boltivTransactionOverlay");
            return;
        }

        const overlay=document.createElement("div");
        overlay.id="boltivTransactionOverlay";
        overlay.className="boltiv-transaction-overlay";
        overlay.innerHTML=`
            <div class="boltiv-transaction-card">
                <div class="boltiv-receipt-brand"><img src="assets/boltiv-logo.webp" alt="BOLTIV logo"></div>
                <div class="boltiv-transaction-icon" id="boltivTransactionIcon"></div>
                <div class="boltiv-transaction-status" id="boltivTransactionStatus">Processing</div>
                <div class="boltiv-transaction-title" id="boltivTransactionTitle">Please wait</div>
                <div class="boltiv-transaction-message" id="boltivTransactionMessage">Your transaction is being processed.</div>
                <div class="boltiv-transaction-details" id="boltivTransactionDetails"></div>
                <button class="boltiv-transaction-button" id="boltivTransactionButton">DONE</button>
            </div>
        `;

        document.body.appendChild(overlay);
        this.overlay=overlay;
        document.getElementById("boltivTransactionButton").addEventListener("click",()=>this.close());
    },

    showProcessing(data={}){
        this.init();
        this.overlay.className="boltiv-transaction-overlay show processing";
        document.getElementById("boltivTransactionIcon").innerHTML=`<div class="boltiv-spinner"></div>`;
        document.getElementById("boltivTransactionStatus").textContent="PROCESSING";
        document.getElementById("boltivTransactionTitle").textContent=data.title||"Processing Transaction";
        document.getElementById("boltivTransactionMessage").textContent=data.message||"Please wait while we process your transaction.";
        document.getElementById("boltivTransactionDetails").innerHTML=this.details(data);
        document.getElementById("boltivTransactionButton").style.display="none";
    },

    showSuccess(data={}){
        this.init();
        this.overlay.className="boltiv-transaction-overlay show success";
        document.getElementById("boltivTransactionIcon").innerHTML="✓";
        document.getElementById("boltivTransactionStatus").textContent="SUCCESSFUL";
        document.getElementById("boltivTransactionTitle").textContent=data.title||"Transaction Successful";
        document.getElementById("boltivTransactionMessage").textContent=data.message||"Your transaction has been completed successfully.";
        document.getElementById("boltivTransactionDetails").innerHTML=this.details(data);

        const button=document.getElementById("boltivTransactionButton");
        button.textContent=data.buttonText||"DONE";
        button.style.display="block";
    },

    showFailed(data={}){
        this.init();
        this.overlay.className="boltiv-transaction-overlay show failed";
        document.getElementById("boltivTransactionIcon").innerHTML="×";
        document.getElementById("boltivTransactionStatus").textContent="FAILED";
        document.getElementById("boltivTransactionTitle").textContent=data.title||"Transaction Failed";
        document.getElementById("boltivTransactionMessage").textContent=data.message||"We couldn't complete this transaction.";
        document.getElementById("boltivTransactionDetails").innerHTML=this.details(data);

        const button=document.getElementById("boltivTransactionButton");
        button.textContent=data.buttonText||"TRY AGAIN";
        button.style.display="block";
    },

    details(data){
        let html="";
        if(data.service)html+=`<div class="transaction-detail"><span>Service</span><strong>${this.escape(data.service)}</strong></div>`;
        if(data.amount!==undefined&&data.amount!==null&&data.amount!=="")html+=`<div class="transaction-detail"><span>Amount</span><strong>${this.escape(data.amount)}</strong></div>`;
        if(data.phone)html+=`<div class="transaction-detail"><span>Phone</span><strong>${this.escape(data.phone)}</strong></div>`;
        if(data.network)html+=`<div class="transaction-detail"><span>Network</span><strong>${this.escape(data.network)}</strong></div>`;
        if(data.recipient)html+=`<div class="transaction-detail"><span>Recipient</span><strong>${this.escape(data.recipient)}</strong></div>`;
        if(data.transactionId)html+=`<div class="transaction-detail"><span>Transaction ID</span><strong>${this.escape(data.transactionId)}</strong></div>`;
        return html;
    },

    close(){
        if(this.overlay)this.overlay.classList.remove("show");
    },

    escape(value){
        return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
    }
};

async function boltivBackendCheck(){
    const result=await BoltivAPI.health();
    if(result.success)console.log("BOLTIV BACKEND ONLINE",result);
    else console.error("BOLTIV BACKEND OFFLINE",result);
    return result;
}

document.addEventListener("DOMContentLoaded",()=>{
    BoltivTransaction.init();
    boltivBackendCheck();
});

/* END OF BOLTIV TRANSACTION UI + API */
