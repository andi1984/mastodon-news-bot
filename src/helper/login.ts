import type { MastoClient } from "masto";
import masto = require("masto");

const getInstance = async (): Promise<MastoClient> => {
  return await masto.login({
    url: process.env.API_INSTANCE as string,
    accessToken: process.env.ACCESS_TOKEN as string,
  });
};

export default getInstance;
