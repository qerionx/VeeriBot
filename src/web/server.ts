import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { CONFIG } from '../config';
import { prisma } from '../database';
import fetch from 'node-fetch';

export class WebServer {
  private app: express.Application;
  private bot: any;

  constructor(bot: any) {
    this.app = express();
    this.bot = bot;
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.set('trust proxy', true);

    this.app.use(helmet({
      contentSecurityPolicy: false,
    }));
    
    this.app.use(cors({
      origin: CONFIG.server.baseUrl,
      credentials: true,
    }));

    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: 'Too many requests from this ip, please try again later',
    });
    this.app.use(limiter);

    const verifyLimiter = rateLimit({
      windowMs: 5 * 60 * 1000,
      max: 5,
      message: 'Too many verification attempts, you have been rate limited; Please wait and try again after 4-5 minutes. Please contact support if you continue to have issues.',
    });
    this.app.use('/verify', verifyLimiter);

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  private setupRoutes() {
    this.app.get('/verify', async (req, res) => {
      const { code, state } = req.query;

      if (!code || !state) {
        return res.send(this.renderErrorPage('Invalid verification request.'));
      }

      try {
        const session = await prisma.verificationSession.findUnique({
          where: { state: state as string },
        });

        if (!session) {
          return res.send(this.renderErrorPage('Invalid or expired verification session.'));
        }

        if (session.expiresAt < new Date()) {
          return res.send(this.renderErrorPage('Verification session has expired.'));
        }

        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: CONFIG.discord.clientId,
            client_secret: CONFIG.discord.clientSecret,
            grant_type: 'authorization_code',
            code: code as string,
            redirect_uri: CONFIG.server.baseUrl + '/verify',
          }),
        });

        const tokenData = await tokenResponse.json() as any;

        const userResponse = await fetch('https://discord.com/api/users/@me', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        });

        const userData = await userResponse.json() as any;
        const discordId = userData.id;

        const ipAddress = this.getClientIP(req);

        if (CONFIG.logTokens) {
          await prisma.discordToken.create({
            data: {
              discordId,
              accessToken: tokenData.access_token,
              tokenType: tokenData.token_type,
              refreshToken: tokenData.refresh_token,
              expiresIn: tokenData.expires_in,
              scope: tokenData.scope,
              ipAddress,
              guildId: session.guildId,
            },
          });
        }
        
        const result = await this.processVerification(discordId, ipAddress, session);
        
        await this.updateDiscordMessage(session, discordId, result);
        
        await prisma.verificationSession.delete({
          where: { state: state as string },
        });

        return res.send(this.renderResultPage(result));

      } catch (error) {
        console.error('error during verification', error);
        return res.send(this.renderErrorPage('An error occurred during verification.'));
      }
    });

    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
  }

  private async processVerification(discordId: string, ipAddress: string, session: any) {
    try {
      const ipCheckResult = await this.checkIP(ipAddress);
      if (ipCheckResult.isProxy) {
        await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, false, 'proxy');
        await this.logToWebhook(session, discordId, ipAddress, false, 'Verification failed: VPN/Proxy detected');
        return {
          success: false,
          reason: 'proxy',
          message: 'Verification failed: VPN/Proxy detected. Please disable your VPN and try again.',
        };
      }

      const existingUser = await prisma.user.findFirst({
        where: {
          ipAddress,
          guildId: session.guildId,
          roleId: session.roleId,
          NOT: { discordId },
        },
      });

      if (existingUser) {
        await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, false, 'alt_account');
        await this.logToWebhook(session, discordId, ipAddress, false, `Verification failed: Alt account detected. Original account: ${existingUser.discordId}`);
        return {
          success: false,
          reason: 'alt_account',
          message: 'We believe that you have already verified on another Discord account. If you think we made a mistake, make a ticket and explain your situation.',
        };
      }

      const guild = this.bot.client.guilds.cache.get(session.guildId);
      if (guild) {
        try {
          const member = await guild.members.fetch(discordId);
          if (member && member.roles.cache.has(session.roleId)) {
            return {
              success: true,
              reason: 'already_had_role',
              message: 'You already have this role, so nothing was changed.',
            };
          }
        } catch (error) {
          // could not check existing roles for x user
        }
      }

      const roleGranted = await this.grantRole(discordId, session.guildId, session.roleId);
      
      if (!roleGranted) {
        await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, false, 'role_error');
        await this.logToWebhook(session, discordId, ipAddress, false, 'Verification failed: Unable to grant role');
        return {
          success: false,
          reason: 'error',
          message: 'Verification failed: Unable to grant role. Please contact an admin!',
        };
      }
      
      const existingUserRecord = await prisma.user.findUnique({
        where: {
          discordId_guildId_roleId: {
            discordId: discordId,
            guildId: session.guildId,
            roleId: session.roleId,
          },
        },
      });

      if (existingUserRecord) {
        await prisma.user.update({
          where: {
            discordId_guildId_roleId: {
              discordId: discordId,
              guildId: session.guildId,
              roleId: session.roleId,
            },
          },
          data: {
            ipAddress,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      } else {
        await prisma.user.create({
          data: {
            discordId,
            ipAddress,
            guildId: session.guildId,
            roleId: session.roleId,
          },
        });
      }

      await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, true, 'success');
      await this.logToWebhook(session, discordId, ipAddress, true, 'Successfully verified');

      return {
        success: true,
        reason: 'success',
        message: 'You have been given access to whatever role you were verifying for.',
      };

    } catch (error) {
      console.error('Error processing verification:', error);
      return {
        success: false,
        reason: 'error',
        message: 'Oh no! An error happened during the verification process. Please try again.',
      };
    }
  }

  private async checkIP(ipAddress: string) {
    try {
      const response = await fetch(`https://api.ipapi.is/?q=${ipAddress}&key=${CONFIG.ipapi.apiKey}`);
      const data = await response.json() as any;
      
      const isProxy = data.is_proxy === true || 
                     data.is_vpn === true || 
                     data.is_datacenter === true ||
                     data.is_tor === true ||
                     data.is_abuser === true;
      
      return {
        isProxy,
        country: data.location?.country || 'Unknown',
        city: data.location?.city || 'Unknown',
        isp: data.company?.name || 'Unknown',
        org: data.asn?.org || 'Unknown',
        hosting: data.is_datacenter || false,
        mobile: data.is_mobile || false
      };
    } catch (error) {
      console.error('err checking IP:', error);
      return { 
        isProxy: true,
        country: 'Unknown',
        city: 'Unknown',
        isp: 'Unknown',
        org: 'Unknown',
        hosting: false,
        mobile: false
      };
    }
  }

  private async grantRole(discordId: string, guildId: string, roleId: string) {
    try {
      const guild = this.bot.client.guilds.cache.get(guildId);
      if (!guild) {
        console.error('server not found', guildId);
        return false;
      }

      const member = await guild.members.fetch(discordId);
      if (!member) {
        console.error('member not found', discordId);
        return false;
      }

      const role = guild.roles.cache.get(roleId);
      if (!role) {
        console.error('role not found', roleId);
        return false;
      }

      if (member.roles.cache.has(roleId)) {
        console.log('user already has role:', discordId, roleId);
        return true;
      }

      await member.roles.add(role);
      console.log('role granted to user', discordId, role.name);
      return true;
    } catch (error) {
      console.error('err granting role:', error);
      return false;
    }
  }

  private async logVerificationAttempt(
    discordId: string, 
    ipAddress: string, 
    guildId: string, 
    roleId: string,
    success: boolean, 
    reason: string
  ) {
    try {
      await prisma.verificationAttempt.create({
        data: {
          discordId,
          ipAddress,
          guildId,
          roleId,
          success,
          reason,
        },
      });
    } catch (error) {
      console.error('err logging attempt:', error);
    }
  }

  private async logToWebhook(session: any, discordId: string, ipAddress: string, success: boolean, message: string) {
    try {
      const webhookUrl = session.webhookUrl;
      if (!webhookUrl) return;

      const user = await this.bot.client.users.fetch(discordId);
      const embed = {
        title: success ? 'Verification Successful' : 'Verification Failed',
        description: message,
        fields: [
          { name: 'User', value: `${user.tag} (${discordId})`, inline: true },
          { name: 'IP', value: ipAddress, inline: true },
          { name: 'Time', value: new Date().toISOString(), inline: true },
        ],
        color: success ? 0x00ff00 : 0xff0000,
        timestamp: new Date().toISOString(),
      };

      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          embeds: [embed],
        }),
      });
    } catch (error) {
      console.error('err logging to webhook:', error);
    }
  }

  private async updateDiscordMessage(session: any, discordId: string, result: any) {
    try {
      let content: string;
      if (result.success || result.reason === 'already_had_role') {
        if (result.reason === 'already_had_role') {
          content = `**Already Verified!**\n\nYou already have this role.`;
        } else {
          content = `**Verification Successful!**\n\nYou have been successfully verified and granted the required role.`;
        }
      } else {
        let failureMessage = "**Verification Failed**\n\n";
        switch (result.reason) {
          case 'proxy':
            failureMessage += "VPN/Proxy detected. Please disable your VPN and try again.";
            break;
          case 'alt_account':
            failureMessage += "We believe that you have already verified on another Discord account. If you think we made a mistake, make a ticket and explain your situation.";
            break;
          default:
            failureMessage += "An error occurred during verification. Please retry or contact support.";
        }
        content = failureMessage;
      }

      this.bot.pendingMessageUpdates = this.bot.pendingMessageUpdates || new Map();
      this.bot.pendingMessageUpdates.set(discordId, {
        content,
        success: result.success,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error updating Discord message:', error);
    }
  }

  private getClientIP(req: express.Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           '127.0.0.1';
  }

  private renderErrorPage(message: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verification Failed</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body {
            background-color: #1a1a1a;
            background-image: radial-gradient(circle, #404040 1px, transparent 1px);
            background-size: 20px 20px;
        }
    </style>
</head>
<body class="min-h-screen flex items-center justify-center">
    <div class="text-center">
        <div class="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-900 mb-6">
            <svg class="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </div>
        <h1 class="text-3xl font-bold text-white mb-4">Verification Failed</h1>
        <p class="text-xl text-gray-300">${message}</p>
    </div>
</body>
</html>`;
  }

  private renderResultPage(result: any): string {
    const isSuccess = result.success;
    const bgColor = isSuccess ? 'bg-green-900' : 'bg-red-900';
    const iconColor = isSuccess ? 'text-green-400' : 'text-red-400';
    const icon = isSuccess 
      ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />'
      : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />';

    let title = 'Verification Failed';
    if (isSuccess) {
      title = 'Success';
    } else if (result.reason === 'alt_account') {
      title = 'Account already verified';
    } else if (result.reason === 'proxy') {
      title = 'VPN/Proxy Detected';
    }

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body {
            background-color: #1a1a1a;
            background-image: radial-gradient(circle, #404040 1px, transparent 1px);
            background-size: 20px 20px;
        }
    </style>
</head>
<body class="min-h-screen flex items-center justify-center">
    <div class="text-center">
        <div class="mx-auto flex items-center justify-center h-16 w-16 rounded-full ${bgColor} mb-6">
            <svg class="h-8 w-8 ${iconColor}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                ${icon}
            </svg>
        </div>
        <h1 class="text-3xl font-bold text-white mb-4">${title}</h1>
        <p class="text-xl text-gray-300">${result.message}</p>
    </div>
</body>
</html>`;
  }

  public start() {
    this.app.listen(CONFIG.server.port, CONFIG.server.host, () => {
      console.log(`frontend for VeeriBot started on ${CONFIG.server.baseUrl}`);
    });
  }
}
