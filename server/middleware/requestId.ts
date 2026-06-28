import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export function attachRequestId(req: Request & { requestId?: string }, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}
