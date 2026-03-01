const fs = require("fs");
fs.writeFileSync(
  "./.env",
  `API_INSTANCE=${process.env.API_INSTANCE}\nACCESS_TOKEN=${process.env.ACCESS_TOKEN}\n`
);
