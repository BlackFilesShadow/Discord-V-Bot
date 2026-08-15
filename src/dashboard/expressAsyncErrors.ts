/**
 * Express 4 reicht abgelehnte Promises aus async Route-Handlern nicht
 * automatisch an die Error-Middleware weiter. Dieses Modul wird vor den
 * /api/v2-Routern geladen und bridged Promise-Rejections zentral nach next().
 *
 * Die Implementierung patcht nur den Express-Layer-Handler und bewahrt die
 * Funktionslaenge, damit normale Middleware und 4-argumentige Error-Middleware
 * weiterhin korrekt klassifiziert werden. `router.param()` wird im Projekt
 * nicht verwendet und braucht deshalb keinen Sonderpfad.
 */

type Next = (error?: unknown) => void;
type LayerHandler = (...args: unknown[]) => unknown;

type LayerInstance = {
  __vbotAsyncHandler?: LayerHandler;
};

type LayerConstructor = {
  prototype: LayerInstance & Record<PropertyKey, unknown>;
};

const Layer = require('express/lib/router/layer') as LayerConstructor;
const PATCH_MARKER = Symbol.for('vbot.dashboard.express-v2-async-errors');
const prototype = Layer.prototype;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

if (prototype[PATCH_MARKER] !== true) {
  Object.defineProperty(prototype, 'handle', {
    configurable: true,
    enumerable: true,
    get(this: LayerInstance): LayerHandler | undefined {
      return this.__vbotAsyncHandler;
    },
    set(this: LayerInstance, handler: LayerHandler) {
      const wrapped = function wrappedExpressAsyncHandler(this: unknown, ...args: unknown[]): unknown {
        const result = handler.apply(this, args);
        if (isPromiseLike(result)) {
          const maybeNext = args[args.length - 1];
          if (typeof maybeNext === 'function') {
            Promise.resolve(result).catch((error: unknown) => {
              (maybeNext as Next)(error);
            });
          }
        }
        return result;
      };

      Object.defineProperty(wrapped, 'length', {
        configurable: true,
        value: handler.length,
      });
      Object.assign(wrapped, handler);
      this.__vbotAsyncHandler = wrapped;
    },
  });

  Object.defineProperty(prototype, PATCH_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}

export {};
