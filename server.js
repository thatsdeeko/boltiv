// BOLTIV BACKEND
// Basic API foundation. No real money/API connection yet.

const http=require("node:http");
const PORT=process.env.PORT||3000;

const server=http.createServer((req,res)=>{
    // CORS
    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");

    // Preflight
    if(req.method==="OPTIONS"){
        res.writeHead(204);
        return res.end();
    }

    // Health check
    if(req.method==="GET"&&req.url==="/api/health"){
        res.writeHead(200,{"Content-Type":"application/json"});
        return res.end(JSON.stringify({
            success:true,
            app:"BOLTIV",
            status:"online",
            message:"BOLTIV backend is running"
        }));
    }

    // Unknown route
    res.writeHead(404,{"Content-Type":"application/json"});
    res.end(JSON.stringify({
        success:false,
        message:"API route not found"
    }));
});

server.listen(PORT,()=>{
    console.log(`BOLTIV API running on port ${PORT}`);
});