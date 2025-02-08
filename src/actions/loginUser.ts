import type { PrismaClient } from "@prisma/client";
import { UAParser } from "ua-parser-js";
import type { SpectraAuthConfig } from "../config";
import { verifyPassword } from "../security";
import {
  type ActionResponse,
  type ClientSession,
  type ClientUser,
  ErrorCodes,
  type PrismaUser,
} from "../types";
import {
  clientSafeUser,
  createRouteLimiter,
  createTime,
  limitIpAttempts,
} from "../utils";
import { loginSchema } from "../validations";
import { createSession } from "./createSession";

export async function loginUser({
  options,
  prisma,
  config,
}: {
  options: {
    input: {
      usernameOrEmail: string;
      password: string;
    };
    ipAddress?: string;
    userAgent?: string;
  };
  prisma: PrismaClient;
  config: Required<SpectraAuthConfig>;
}): Promise<ActionResponse<{ user: ClientUser; session: ClientSession }>> {
  const { input, ipAddress, userAgent } = options;
  const { device, browser, os } = UAParser(userAgent);

  if (config.rateLimiting.login.enabled && ipAddress) {
    const limiter = createRouteLimiter({ routeKey: "login", config });
    const limit = await limitIpAttempts({ ipAddress, rateLimiter: limiter });

    if (!limit.success) {
      config.logger.securityEvent("RATE_LIMIT_EXCEEDED", {
        route: "login",
        ipAddress,
      });

      return {
        success: false,
        status: 429,
        message: "Too many attempts. Try again later.",
        code: ErrorCodes.RATE_LIMIT_EXCEEDED,
      };
    }
  }

  const credentials = loginSchema.safeParse(input);
  if (!credentials.success) {
    config.logger.securityEvent("INVALID_INPUT", {
      route: "login",
      ipAddress,
      ...input,
    });

    return {
      success: false,
      status: 400,
      message: "Invalid input provided",
      code: ErrorCodes.INVALID_INPUT,
    };
  }

  const user = (await prisma.user.findFirst({
    where: {
      OR: [
        { email: credentials.data.usernameOrEmail },
        { username: credentials.data.usernameOrEmail },
      ],
    },
  })) as PrismaUser | null;

  if (!user) {
    config.logger.securityEvent("USER_NOT_FOUND", {
      route: "login",
      ipAddress,
      ...input,
    });

    return {
      success: false,
      status: 404,
      message: "User not found",
      code: ErrorCodes.USER_NOT_FOUND,
    };
  }

  if (user.isBanned) {
    config.logger.securityEvent("ACCOUNT_BANNED", {
      route: "login",
      ipAddress,
      userId: user.id,
    });

    return {
      success: false,
      status: 403,
      message: "Account is banned",
      code: ErrorCodes.ACCOUNT_BANNED,
    };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    config.logger.securityEvent("ACCOUNT_LOCKED", {
      route: "login",
      ipAddress,
      userId: user.id,
    });

    const lockedUntil = createTime(user.lockedUntil.getTime(), "ms");

    return {
      success: false,
      status: 403,
      message: `Account locked. Try again ${lockedUntil.fromNow}.`,
      code: ErrorCodes.ACCOUNT_LOCKED,
    };
  }

  const passwordMatch = await verifyPassword({
    hash: user.password,
    password: credentials.data.password,
    config,
  });

  if (!passwordMatch) {
    config.logger.securityEvent("INVALID_CREDENTIALS", {
      route: "login",
      ipAddress,
      userId: user.id,
    });

    let failedLoginAttempts = user.failedLoginAttempts + 1;
    let lockedUntil: Date | null = null;

    if (failedLoginAttempts >= config.accountSecurity.maxFailedLogins) {
      lockedUntil = createTime(
        config.accountSecurity.lockoutDurationSeconds,
        "s",
      ).getDate();
      failedLoginAttempts = 0;
      config.logger.securityEvent("ACCOUNT_LOCKED", {
        route: "login",
        ipAddress,
        userId: user.id,
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts, lockedUntil },
    });

    return {
      success: false,
      status: 401,
      message: "Invalid credentials",
      code: ErrorCodes.INVALID_CREDENTIALS,
    };
  }

  if (
    !user.isEmailVerified &&
    config.accountSecurity.requireEmailVerification
  ) {
    config.logger.securityEvent("EMAIL_NOT_VERIFIED", {
      route: "login",
      ipAddress,
      userId: user.id,
    });

    return {
      success: false,
      status: 403,
      message: "Email not verified",
      code: ErrorCodes.EMAIL_NOT_VERIFIED,
    };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });

  const newSession = await createSession({
    options: {
      userId: user.id,
      ipAddress,
      location: "",
      country: "",
      device: device.type ?? "Desktop",
      browser: browser.name ?? "Unknown",
      os: os.name ?? "Unknown",
      userAgent,
    },
    prisma,
    config,
  });

  if (!newSession.success || !newSession.data?.session) {
    return {
      success: false,
      status: 500,
      message: "Failed to create session",
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
    };
  }

  config.logger.securityEvent("LOGIN_SUCCESS", {
    route: "login",
    ipAddress,
    userId: user.id,
  });

  const clientUser = clientSafeUser({ user });

  return {
    success: true,
    status: 200,
    message: "Login successful",
    data: { user: clientUser, session: newSession.data.session },
  };
}
