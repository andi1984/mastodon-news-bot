import { createRestAPIClient } from "masto";

const getInstance = async () => {
  return await createRestAPIClient({
    url: process.env.API_INSTANCE as string,
    accessToken: process.env.ACCESS_TOKEN as string,
  });
};

export default getInstance;
