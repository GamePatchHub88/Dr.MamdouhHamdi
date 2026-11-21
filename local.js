require('dotenv').config();require('./lib/app').listen(process.env.PORT||3000,()=>console.log('http://localhost:'+(process.env.PORT||3000)));
