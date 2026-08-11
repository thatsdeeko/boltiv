// BOLTIV BACKEND
// Basic API foundation

const http=require("node:http");
const PORT=process.env.PORT||3000;

const server=http.createServer((req,res)=>{
    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");
    res.setHeader("Content-Type","application/json");

    if(req.method==="OPTIONS"){
        res.writeHead(204);
        return res.end();
    }

    const path=req.url.split("?")[0];

    if(req.method==="GET"&&(path==="/"||path==="/api/health")){
        res.writeHead(200);
        return res.end(JSON.stringify({
            success:true,
            app:"BOLTIV",
            status:"online",
            message:"BOLTIV backend is running"
        }));
    }

    res.writeHead(404);
    res.end(JSON.stringify({
        success:false,
        message:"API route not found",
        path:path
    }));
});

server.listen(PORT,()=>{
    console.log(`BOLTIV API running on port ${PORT}`);
});
