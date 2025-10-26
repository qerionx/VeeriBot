import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function connectDatabase() {
  try {
    await prisma.$connect();
    console.log('db connected successfully');
  } catch (error) {
    console.error('db connection failed:', error);
    process.exit(1);
  }
}

export async function disconnectDatabase() {
  await prisma.$disconnect();
}