import { Request, Response, NextFunction } from 'express';
import { httpDuration } from '../lib/metrics.js';

export function observeHttp(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer({ method: req.method, route: req.path });
  res.on('finish', () => end({ status: String(res.statusCode) }));
  next();
}
