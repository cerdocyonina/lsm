import chalk from "chalk";
import winston from "winston";
import "winston-daily-rotate-file";

const isVerbose = process.argv.includes("-v") || process.argv.includes("--verbose");

const consoleFormat = winston.format.printf(
  ({
    level,
    message,
    timestamp,
  }: {
    level: string;
    message: unknown;
    timestamp?: string;
  }) => {
    let levelChalk = chalk.white;
    switch (level.toLowerCase()) {
      case "debug":
        levelChalk = chalk.rgb(128, 150, 150);
        break;
      case "info":
        levelChalk = chalk.green;
        break;
      case "warn":
        levelChalk = chalk.yellow;
        break;
      case "error":
        levelChalk = chalk.red;
        break;
    }

    const LEVEL_STRING_WIDTH = 7;
    const levelString =
      " ".repeat(LEVEL_STRING_WIDTH - level.length - 2) +
      `[${levelChalk(level.toUpperCase())}]`;
    const dateTimeStr = new Date(timestamp ?? Date.now()).toLocaleString("ru-RU");
    return `${chalk.gray(dateTimeStr)} ${levelString}: ${message}`;
  },
);

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.DailyRotateFile({
      level: "info",
      filename: "logs/application-%DATE%.log",
      datePattern: "YYYY-MM-DD-HH",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d",
    }),
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.NODE_ENV === "development" || isVerbose ? "debug" : "info",
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: "logs/rejections.log" }),
  ],
});

export function logError(error: unknown): void {
  if (error instanceof Error) {
    logger.error(error.message);
    if (error.stack) logger.error(error.stack);
    if (error.cause) logError(error.cause);
    return;
  }

  logger.error(String(error));
}
