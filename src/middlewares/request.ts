import type { Request, Response, NextFunction } from "express";

export const showRequestLog = (req: Request, _res: Response, next: NextFunction): void => {
  const currentTime = new Date().toISOString();
  const method = req.method;
  const reqPath = req.originalUrl;
  const ip = req.ip || req.socket.remoteAddress;

  console.log(`${currentTime} - ${ip} - ${method} - ${reqPath}`);
  next();
};

export const showResponseErrorLog = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const currentTime = new Date().toISOString();
  const method = req.method;
  const reqPath = req.originalUrl;
  const ip = req.ip || req.socket.remoteAddress;

  const originalSend = res.send.bind(res);
  res.send = (body: unknown) => {
    req.sendBody = body;
    return originalSend(body);
  };

  res.on("finish", () => {
    const status = res.statusCode;
    if (status < 200 || status >= 300) {
      console.log(`${currentTime} - ${ip} - ${method} - ${reqPath} - ${status}`);
      if (status >= 500) {
        try {
          const json =
            typeof req.sendBody === "string" ? JSON.parse(req.sendBody) : req.sendBody;
          console.error("Error response body:", JSON.stringify(json, null, 2));
        } catch {
          console.error("Error response body (non-JSON):", req.sendBody);
        }
      }
    }
  });

  next();
};
