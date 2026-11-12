/**
 * AIOStreams Integrated: desktop-only routes, installed ahead of every upstream
 * middleware by a single call in app.ts. Nothing here runs outside the desktop
 * app. The access boundary itself lives in desktop.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import {
  appConfig,
  checkAuthToken,
  getEffectivePermissions,
  Permission,
} from '@aiostreams/core';
import {
  desktopBoundary,
  desktopOptions,
  type DesktopOptions,
} from './desktop.js';

export interface DesktopInstall {
  internalHeader: string;
  internalSecret: string;
  establishSession(req: Request, res: Response): void;
  /** Development fallback; packages pass AIOSTREAMS_DESKTOP_WEB_DIR. */
  clientRoot: string;
}

/** The internal dashboard account; never reported as a user account. */
const INTERNAL_USER = 'desktop';

/**
 * Install the private boundary and the desktop-only routes, before every
 * upstream middleware. Returns undefined, and changes nothing, outside the
 * desktop app.
 */
export function installDesktop(
  app: Express,
  install: DesktopInstall
): DesktopOptions | undefined {
  const options = desktopOptions(process.env);
  app.use(
    desktopBoundary(
      options,
      install.internalHeader,
      install.internalSecret,
      install.establishSession
    )
  );
  if (!options) return undefined;

  app.get('/__desktop/source', (_req, res) => {
    const archive = process.env.AIOSTREAMS_DESKTOP_SOURCE_ARCHIVE;
    if (!archive || !path.isAbsolute(archive) || !fs.existsSync(archive)) {
      res.status(404).json({
        success: false,
        detail: 'Source archive is not present in this development build',
      });
      return;
    }
    res.download(
      path.basename(archive),
      'aiostreams-integrated-source.tar.gz',
      { root: path.dirname(archive) }
    );
  });

  // The accounts upstream actually loaded from AIOSTREAMS_AUTH at startup, so
  // the setup screen can confirm a saved account reached the running server.
  app.get('/__desktop/accounts', (_req, res) => {
    const accounts = [...(appConfig.bootstrap.auth?.keys() ?? [])]
      .filter((username) => username !== INTERNAL_USER)
      .map((username) => ({
        username,
        permissions: [...getEffectivePermissions(username)].sort(),
      }));
    res.json({ success: true, accounts });
  });

  // Runs the same check the built-in Usenet service uses before streaming
  // (checkAuthToken with the service permission). Never echoes the password.
  app.post(
    '/__desktop/account-check',
    express.json({ limit: '4kb' }),
    (req, res) => {
      const credential: unknown = req.body?.credential;
      const check = checkAuthToken(
        typeof credential === 'string' ? credential : '',
        Permission.Service
      );
      res.json(
        check.ok
          ? { success: true, username: check.username }
          : { success: false, detail: check.reason }
      );
    }
  );

  app.use(
    '/__desktop/client',
    express.static(process.env.AIOSTREAMS_DESKTOP_WEB_DIR || install.clientRoot, {
      index: 'index.html',
      fallthrough: false,
    })
  );
  return options;
}
