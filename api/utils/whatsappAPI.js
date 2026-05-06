const axios = require('axios');
const { Instance } = require('../models');

class WhatsAppAPI {
  constructor() {
    this.apiVersion = process.env.META_API_VERSION || 'v21.0';
  }

  // Get instance details
  async getInstance(instanceId) {
    try {
      const instance = await Instance.findOne({
        numberId: instanceId,
        isActive: true,
        isDeleted: false
      });
      if (!instance || !instance.isActive) {
        throw new Error('Instance not found or inactive');
      }
      return instance;
    } catch (error) {
      console.error('Get instance error:', error);
      throw error;
    }
  }

  // Send text message
  async sendMessage(instanceId, to, text) {
    try {
      const instance = await this.getInstance(instanceId);
      const baseURL = `https://graph.facebook.com/${this.apiVersion}/${instance.numberId}`;

      const response = await axios.post(
        `${baseURL}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'text',
          text: { body: text }
        },
        {
          headers: {
            'Authorization': `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp send message error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Send media message (image, video, document, audio)
  async sendMedia(instanceId, to, mediaType, mediaUrl, caption = null) {
    try {
      const instance = await this.getInstance(instanceId);
      const baseURL = `https://graph.facebook.com/${this.apiVersion}/${instance.numberId}`;

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: mediaType,
        [mediaType]: {
          link: mediaUrl
        }
      };

      if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
        payload[mediaType].caption = caption;
      }

      const response = await axios.post(
        `${baseURL}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp send media error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Mark message as read
  async markAsRead(instanceId, messageId) {
    try {
      const instance = await this.getInstance(instanceId);
      const baseURL = `https://graph.facebook.com/${this.apiVersion}/${instance.numberId}`;

      const response = await axios.post(
        `${baseURL}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        },
        {
          headers: {
            'Authorization': `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp mark as read error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Download media from WhatsApp
  async downloadMedia(instanceId, mediaId) {
    try {
      const instance = await this.getInstance(instanceId);

      // First get media URL
      const mediaUrlResponse = await axios.get(
        `https://graph.facebook.com/${this.apiVersion}/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${instance.accessToken}`
          }
        }
      );

      const mediaUrl = mediaUrlResponse.data.url;

      // Download media
      const mediaResponse = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${instance.accessToken}`
        },
        responseType: 'arraybuffer'
      });

      return {
        data: mediaResponse.data,
        mimeType: mediaResponse.headers['content-type']
      };
    } catch (error) {
      console.error('WhatsApp download media error:', error.response?.data || error.message);
      throw error;
    }
  }

  // React to a message
  async reactToMessage(instanceId, to, messageId, emoji) {
    try {
      const instance = await this.getInstance(instanceId);
      const baseURL = `https://graph.facebook.com/${this.apiVersion}/${instance.numberId}`;

      const response = await axios.post(
        `${baseURL}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'reaction',
          reaction: {
            message_id: messageId,
            emoji: emoji
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp react error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Send reply to a message
  async replyToMessage(instanceId, to, text, replyToMessageId) {
    try {
      const instance = await this.getInstance(instanceId);
      const baseURL = `https://graph.facebook.com/${this.apiVersion}/${instance.numberId}`;

      const response = await axios.post(
        `${baseURL}/messages`,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          context: {
            message_id: replyToMessageId
          },
          type: 'text',
          text: { body: text }
        },
        {
          headers: {
            'Authorization': `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp reply error:', error.response?.data || error.message);
      throw error;
    }
  }
}

module.exports = new WhatsAppAPI();