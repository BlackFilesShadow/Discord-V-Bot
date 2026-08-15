import type { NextFunction, Request, Response } from 'express';
import { v2AsyncErrorBoundary } from '../../src/dashboard/middleware/v2AsyncErrorBoundary';

describe('v2AsyncErrorBoundary', () => {
  it('delegates ordinary errors to the global dashboard error handler', () => {
    const error = new Error('boom');
    const next = jest.fn() as unknown as NextFunction;
    const res = {
      headersSent: false,
      destroy: jest.fn(),
    } as unknown as Response;

    v2AsyncErrorBoundary(error, {} as Request, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('terminates a partial streamed response instead of attempting a second response', () => {
    const error = new Error('stream failed');
    const next = jest.fn() as unknown as NextFunction;
    const destroy = jest.fn();
    const res = {
      headersSent: true,
      destroy,
    } as unknown as Response;

    v2AsyncErrorBoundary(error, {} as Request, res, next);

    expect(destroy).toHaveBeenCalledWith(error);
    expect(next).not.toHaveBeenCalled();
  });
});
