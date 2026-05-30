import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

const SQS_MESSAGING_QUEUE = process.env.SQS_MESSAGING_QUEUE_URL || process.env.SQS_MEDIA_QUEUE_URL;
const REGION = process.env.AWS_REGION || "eu-west-1";

let sqsClient = null;

const getClient = () => {
  if (!sqsClient) {
    sqsClient = new SQSClient({
      region: REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return sqsClient;
};

export const publishMessageToSQS = async (payload) => {
  if (!SQS_MESSAGING_QUEUE) {
    console.warn("[SQS] No SQS_MESSAGING_QUEUE_URL configured, skipping SQS publish");
    return null;
  }
  try {
    const client = getClient();
    const command = new SendMessageCommand({
      QueueUrl: SQS_MESSAGING_QUEUE,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: payload.conversation_id || "default",
      MessageDeduplicationId: `${payload.conversation_id || "default"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
    const result = await client.send(command);
    console.log(`[SQS] Message published: ${result.MessageId}`);
    return result;
  } catch (err) {
    console.error("[SQS] Publish error:", err.message);
    return null;
  }
};

export const pollMessagesFromSQS = async (maxMessages = 10, waitTimeSeconds = 5) => {
  if (!SQS_MESSAGING_QUEUE) {
    console.warn("[SQS] No SQS_MESSAGING_QUEUE_URL configured, skipping SQS poll");
    return [];
  }
  try {
    const client = getClient();
    const command = new ReceiveMessageCommand({
      QueueUrl: SQS_MESSAGING_QUEUE,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: waitTimeSeconds,
      AttributeNames: ["All"],
      MessageAttributeNames: ["All"],
    });
    const result = await client.send(command);
    if (result.Messages?.length) {
      console.log(`[SQS] Polled ${result.Messages.length} messages`);
      return result.Messages.map((msg) => ({
        receiptHandle: msg.ReceiptHandle,
        body: JSON.parse(msg.Body || "{}"),
        messageId: msg.MessageId,
      }));
    }
    return [];
  } catch (err) {
    console.error("[SQS] Poll error:", err.message);
    return [];
  }
};

export const deleteMessageFromSQS = async (receiptHandle) => {
  if (!SQS_MESSAGING_QUEUE || !receiptHandle) return;
  try {
    const client = getClient();
    const command = new DeleteMessageCommand({
      QueueUrl: SQS_MESSAGING_QUEUE,
      ReceiptHandle: receiptHandle,
    });
    await client.send(command);
  } catch (err) {
    console.error("[SQS] Delete error:", err.message);
  }
};

export const getQueueUrl = async (queueName) => {
  try {
    const client = getClient();
    const command = new GetQueueUrlCommand({ QueueName: queueName });
    const result = await client.send(command);
    return result.QueueUrl;
  } catch (err) {
    console.error(`[SQS] GetQueueUrl error for ${queueName}:`, err.message);
    return null;
  }
};