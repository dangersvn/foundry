import { createServer } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
createServer().listen(port, () => console.log(`listening on http://localhost:${port}`));
