require('dotenv').config();
const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Slash command - opens the modal
app.command('/approve-request', async ({ command, ack, client }) => {
  await ack();

  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'approval_modal',
      private_metadata: command.user_id,
      title: { type: 'plain_text', text: 'Request Approval' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Submit an approval request* :writing_hand:\nFill in the details below and we\'ll DM the approver right away.'
          }
        },
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'approver_block',
          label: { type: 'plain_text', text: 'Who needs to approve this?' },
          element: {
            type: 'users_select',
            action_id: 'approver_select',
            placeholder: { type: 'plain_text', text: 'Select a person' }
          }
        },
        {
          type: 'input',
          block_id: 'request_block',
          label: { type: 'plain_text', text: 'What are you requesting?' },
          element: {
            type: 'plain_text_input',
            action_id: 'request_input',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Describe what you need approved...' }
          }
        },
        {
          type: 'input',
          block_id: 'priority_block',
          label: { type: 'plain_text', text: 'Priority' },
          element: {
            type: 'radio_buttons',
            action_id: 'priority_select',
            options: [
              { text: { type: 'plain_text', text: '🟢 Low' },   value: 'low' },
              { text: { type: 'plain_text', text: '🟡 Medium' }, value: 'medium' },
              { text: { type: 'plain_text', text: '🔴 High' },   value: 'high' }
            ]
          }
        }
      ]
    }
  });
});

// Modal submission - DM the approver
app.view('approval_modal', async ({ ack, view, client }) => {
  await ack();

  const requesterId = view.private_metadata;
  const approverId  = view.state.values.approver_block.approver_select.selected_user;
  const requestText = view.state.values.request_block.request_input.value;
  const priority    = view.state.values.priority_block.priority_select.selected_option.value;

  const priorityLabel = {
    low:    '🟢 Low',
    medium: '🟡 Medium',
    high:   '🔴 High'
  }[priority];

  // Store request context in the button value so we can reconstruct on update
  const requestPayload = JSON.stringify({ requesterId, requestText, priority: priorityLabel });

  const nowUnix = Math.floor(Date.now() / 1000);

  const dm = await client.conversations.open({ users: approverId });
  await client.chat.postMessage({
    channel: dm.channel.id,
    text: `New approval request from <@${requesterId}>`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⏳ New Approval Request' }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*From:*\n<@${requesterId}>` },
          { type: 'mrkdwn', text: `*Priority:*\n${priorityLabel}` },
          { type: 'mrkdwn', text: `*Submitted:*\n<!date^${nowUnix}^{date_short_pretty} at {time}|just now>` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Request:*\n${requestText}`
        }
      },
      { type: 'divider' },
      {
        type: 'actions',
        block_id: 'approval_actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve' },
            style: 'primary',
            action_id: 'approve_request',
            value: requestPayload,
            confirm: {
              title: { type: 'plain_text', text: 'Approve this request?' },
              text: { type: 'mrkdwn', text: 'This will notify the requester immediately.' },
              confirm: { type: 'plain_text', text: 'Yes, approve' },
              deny: { type: 'plain_text', text: 'Cancel' }
            }
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Reject' },
            style: 'danger',
            action_id: 'reject_request',
            value: requestPayload,
            confirm: {
              title: { type: 'plain_text', text: 'Reject this request?' },
              text: { type: 'mrkdwn', text: 'This will notify the requester that their request was rejected.' },
              confirm: { type: 'plain_text', text: 'Yes, reject' },
              deny: { type: 'plain_text', text: 'Cancel' }
            }
          }
        ]
      }
    ]
  });
});

// Helper - builds the updated blocks after a decision
function buildDecisionBlocks(parsed, approverId, approved) {
  const { requesterId, requestText, priority } = parsed;
  const statusHeader = approved ? '✅ Request Approved' : '❌ Request Rejected';
  const decisionLabel = approved ? 'Approved by' : 'Rejected by';
  const footerText = approved
    ? 'Decision recorded — the requester has been notified.'
    : 'The requester has been notified.';

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: statusHeader }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*From:*\n<@${requesterId}>` },
        { type: 'mrkdwn', text: `*Priority:*\n${priority}` },
        { type: 'mrkdwn', text: `*${decisionLabel}:*\n<@${approverId}>` }
      ]
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Request:*\n${requestText}` }
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: footerText }
      ]
    }
  ];
}

// Approve button
app.action('approve_request', async ({ ack, body, client }) => {
  await ack();

  const approverId = body.user.id;
  const parsed     = JSON.parse(body.actions[0].value);

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `Request approved by <@${approverId}>`,
    blocks: buildDecisionBlocks(parsed, approverId, true)
  });

  const dm = await client.conversations.open({ users: parsed.requesterId });
  await client.chat.postMessage({
    channel: dm.channel.id,
    text: `Your request was approved by <@${approverId}>!`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '✅ Your request was approved!' }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Approved by:*\n<@${approverId}>` },
          { type: 'mrkdwn', text: `*Priority:*\n${parsed.priority}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Your request:*\n${parsed.requestText}` }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'You\'re all set to proceed. :rocket:' }
        ]
      }
    ]
  });
});

// Reject button
app.action('reject_request', async ({ ack, body, client }) => {
  await ack();

  const approverId = body.user.id;
  const parsed     = JSON.parse(body.actions[0].value);

  await client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: `Request rejected by <@${approverId}>`,
    blocks: buildDecisionBlocks(parsed, approverId, false)
  });

  const dm = await client.conversations.open({ users: parsed.requesterId });
  await client.chat.postMessage({
    channel: dm.channel.id,
    text: `Your request was rejected by <@${approverId}>.`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '❌ Your request was rejected.' }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Rejected by:*\n<@${approverId}>` },
          { type: 'mrkdwn', text: `*Priority:*\n${parsed.priority}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Your request:*\n${parsed.requestText}` }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'Reach out to the approver directly if you have questions.' }
        ]
      }
    ]
  });
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Approval bot is running!');
})();