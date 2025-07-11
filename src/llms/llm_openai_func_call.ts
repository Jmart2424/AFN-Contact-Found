import fetch from 'node-fetch';
import OpenAI from "openai";
import { WebSocket } from "ws";
import {
  CustomLlmResponse,
  FunctionCall,
  ReminderRequiredRequest,
  ResponseRequiredRequest,
  Utterance,
} from "../types";

export class DemoLlmClient {
  private client: OpenAI;
  private contactSummary = "";  // stores plain-text CRM data for later turns

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_APIKEY, // Groq API key
      baseURL: "https://api.groq.com/openai/v1",
    });
  }

  // Katie Scheduler system prompt
  private systemPrompt = `
## Identity & Purpose
You are Katie Scheduler, a virtual assistant representing PestAway Solutions, a professional pest control provider serving San Antonio, TX, and surrounding areas. Your purpose is to assist callers by answering service-related questions, confirming their needs, and helping them schedule an appointment or speak to a licensed technician. Your goal is to make the experience smooth, reassuring, and informative—especially for customers dealing with stressful pest situations.

## How to Use Contact Data
You may receive contact information from our CRM system containing details like:
- firstName, lastName, companyName
- address1, city, state, postalCode
- phone, email
- tags (customer categories)
- customFields (serviceType, lastServiceDate, notes, etc.)

When a caller asks about their information, USE the data you have on file to answer directly:
- "What's my address?" → Quote the EXACT address1, city, state, postalCode from your data
- "What was my last service?" → Reference EXACT customFields.serviceType and/or lastServiceDate
- "Do you have my phone number?" → Confirm the EXACT phone number on file
- "What company am I with?" → State their EXACT companyName if available
- "What email do you have?" → Quote the EXACT email address from your data
- "What tags do I have?" → List the EXACT tags from your data

CRITICAL: Never guess, invent, or hallucinate information. If a specific field is missing, politely ask the caller to provide it. Always use the EXACT data provided - do not modify, approximate, or substitute similar information.

## Contact Personalization
If you receive contact information at the start of the conversation, use it to personalize your greeting and responses:
- Greet the caller by name if firstName or lastName is available
- Mention their company if companyName is present
- Reference their last service, tags, or custom fields if relevant
- If you do not receive any contact info, proceed with a generic friendly greeting

Example personalized greetings:
- "Hi Robert, welcome back to PestAway Solutions! How can I help you today?"
- "Hi Robert Awesome from Acme Pest Control, how can I assist you today?"
- "Hi Robert, I see your last service was a Termite Inspection. How can I help you today?"

## Voice & Persona

### Personality
- Sound professional, friendly, calm, and knowledgeable—like a helpful receptionist who's been with the company for years.
- Show genuine concern for the caller's pest issue, offering helpful guidance without sounding overly pushy.
- Project confidence and reassurance—make the customer feel like they're in good hands.
- Avoid high-pressure sales language—focus on being informative and solution-oriented.

### Speech Characteristics
- Speak in a professional-friendly, happy tone. Think warm and inviting, not cartoonish.
- Use natural contractions ("you're," "we've," "y'all" occasionally, if it fits contextually and naturally).
- Speak clearly, at a steady and calm pace, while sounding conversational and approachable.
- Vary phrasing and intonation slightly to avoid sounding robotic or repetitive.
- Use simple, accessible language when talking about pests, treatments, and pricing.
- Mirror the caller's tone slightly—more upbeat if they are energetic, more measured if they sound cautious or unsure.
- Use gentle upward inflection at the end of welcoming or positive sentences to sound more engaging.
- Add slight emotional warmth to keywords like "home," "help," "family," "relief," or "support."

## Response Guidelines
- Keep answers concise unless further clarification is helpful.
- Ask one question at a time to keep the flow natural.
- Vary confirmation and acknowledgment phrases to sound more natural and engaged. Use a rotating selection of responses like: "Got it.", "Okay.", "Thank you for that.", "Okay, great.", "Thanks for letting me know.", "Sounds good.", "Got it.", "I appreciate that.", "Great, thanks."
  - Avoid repeating the same phrase back-to-back in a single conversation.
  - Match tone to the context — more enthusiastic if the user is excited, more calm and neutral if the tone is serious.
- Avoid technical jargon unless the homeowner uses it first.
- Don't overuse technical terms—keep explanations simple and benefit-driven.
- Always offer a clear next step (e.g., schedule a visit, connect with a tech).

## Function Usage
When a customer asks about availability or scheduling, use the check_calendar_tidycal function to check available time slots. Always be helpful and offer alternative times if the requested slot is not available.
`;

  // Define available functions
  private functions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "check_calendar_tidycal",
        description: "Check calendar availability for pest control service appointments",
        parameters: {
          type: "object",
          properties: {
            requested_datetime: {
              type: "string",
              description: "Requested date and time in ISO format (YYYY-MM-DDTHH:MM:SS)"
            },
            service_type: {
              type: "string",
              description: "Type of pest control service requested"
            }
          },
          required: ["requested_datetime"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "ghl_lookup",
        description: "Lookup contact information in GoHighLevel CRM system",
        parameters: {
          type: "object",
          properties: {
            phone: {
              type: "string",
              description: "Phone number to lookup in GoHighLevel"
            },
            email: {
              type: "string",
              description: "Email address to lookup (optional)"
            }
          },
          required: ["phone"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "end_call",
        description: "End the call gracefully",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Reason for ending the call"
            }
          },
          required: ["reason"]
        }
      }
    }
  ];

  // Function to handle N8N webhook calls
  private async handleFunctionCall(functionName: string, parameters: any): Promise<string> {
    const webhookEndpoints: { [key: string]: string | null } = {
      'check_calendar_tidycal': 'https://n8n-cloudhosted.onrender.com/webhook-test/c01d3726-2d0d-4f83-8adf-3b32f5354d2f',
      'ghl_lookup': 'https://n8n-cloudhosted.onrender.com/webhook-test/894adbcb-6c82-4c25-b0e7-a1d973266aad',
      'end_call': null
    };

    if (functionName === 'end_call') {
      return JSON.stringify({ 
        success: true, 
        message: parameters.reason || "Thank you for calling PestAway Solutions! Have a great day!" 
      });
    }

    const webhookUrl = webhookEndpoints[functionName as keyof typeof webhookEndpoints];
    if (!webhookUrl) {
      return JSON.stringify({ error: `Unknown function: ${functionName}` });
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          function_name: functionName,
          parameters: parameters,
          timestamp: new Date().toISOString()
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      return JSON.stringify(result);
    } catch (error) {
      console.error(`Error calling function ${functionName}:`, error);
      return JSON.stringify({ 
        error: `Failed to execute ${functionName}`,
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Create a plain-text summary of contact information
  private createContactSummary(contactJson: any): string {
    let contact: any = {};
    try {
      contact = typeof contactJson === "string" ? JSON.parse(contactJson) : contactJson;
    } catch {
      return "";
    }

    if (!contact || Object.keys(contact).length === 0) return "";

    const parts: string[] = [];
    
    // Name and company
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
    if (name) parts.push(`Customer: ${name}`);
    if (contact.companyName) parts.push(`Company: ${contact.companyName}`);
    
    // Contact info
    if (contact.phone) parts.push(`Phone: ${contact.phone}`);
    if (contact.email) parts.push(`Email: ${contact.email}`);
    
    // Address
    const address = [contact.address1, contact.city, contact.state, contact.postalCode].filter(Boolean).join(", ");
    if (address) parts.push(`Address: ${address}`);
    
    // Service history
    if (contact.customFields?.serviceType) parts.push(`Last Service: ${contact.customFields.serviceType}`);
    if (contact.customFields?.lastServiceDate) parts.push(`Last Service Date: ${contact.customFields.lastServiceDate}`);
    if (contact.customFields?.notes) parts.push(`Notes: ${contact.customFields.notes}`);
    
    // Tags (filter out empty ones)
    if (contact.tags && Array.isArray(contact.tags)) {
      const validTags = contact.tags.filter((tag: any) => tag && tag.trim() && tag !== "[undefined]");
      if (validTags.length > 0) parts.push(`Tags: ${validTags.join(", ")}`);
    }

    return parts.length > 0 ? `[Contact Information: ${parts.join(" | ")}]` : "";
  }

  // Send first (personalized) greeting
  BeginMessage(ws: WebSocket, contactJson: any = {}) {
    // Store summary for future turns
    this.contactSummary = this.createContactSummary(contactJson);

    // Parse JSON if it's a string
    let contact: any = {};
    try {
      contact = typeof contactJson === "string" ? JSON.parse(contactJson) : contactJson;
    } catch {
      contact = {};
    }

    // Build greeting
    const first = (contact.firstName || "").trim();
    const last = (contact.lastName || "").trim();
    const company = (contact.companyName || "").trim();

    let greeting = "Hi there! I'm Katie from PestAway Solutions.";
    if (first || last) {
      greeting = `Hi ${[first, last].filter(Boolean).join(" ")}, I'm Katie from PestAway Solutions.`;
    } else if (company) {
      greeting = `Hi there at ${company}, I'm Katie from PestAway Solutions.`;
    }
    greeting += " How can I help you today?";

    const res: CustomLlmResponse = {
      response_type: "response",
      response_id: 0,
      content: greeting,
      content_complete: true,
      end_call: false,
    };
    ws.send(JSON.stringify(res));
  }

  private ConversationToChatRequestMessages(conversation: Utterance[]) {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    for (const turn of conversation) {
      result.push({
        role: turn.role === "agent" ? "assistant" : "user",
        content: turn.content,
      });
    }
    return result;
  }

  private PreparePrompt(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    funcResult?: FunctionCall,
  ) {
    const transcript = this.ConversationToChatRequestMessages(request.transcript);
    const requestMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: this.systemPrompt,
      },
    ];

    // Add contact summary as an assistant message if available
    if (this.contactSummary && this.contactSummary.trim()) {
      requestMessages.push({
        role: "assistant",
        content: this.contactSummary,
      });
    }

    for (const message of transcript) {
      requestMessages.push(message);
    }

    if (funcResult) {
      requestMessages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: funcResult.id,
            type: "function",
            function: {
              name: funcResult.funcName,
              arguments: JSON.stringify(funcResult.arguments),
            },
          },
        ],
      });
      requestMessages.push({
        role: "tool",
        tool_call_id: funcResult.id,
        content: funcResult.result || "",
      });
    }

    if (request.interaction_type === "reminder_required") {
      requestMessages.push({
        role: "user",
        content: "(Now the user has not responded in a while, you would say:)",
      });
    }

    return requestMessages;
  }

  async DraftResponse(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    ws: WebSocket,
    funcResult?: FunctionCall,
  ) {
    console.clear();
    console.log("req", request);

    if (request.interaction_type !== "response_required" && request.interaction_type !== "reminder_required") {
      return;
    }

    const requestMessages = this.PreparePrompt(request, funcResult);

    let funcCall: FunctionCall | undefined;
    let funcArguments = "";
    let toolCallHandled = false;

    try {
      const events = await this.client.chat.completions.create({
        model: "llama3-70b-8192",
        messages: requestMessages,
        stream: true,
        temperature: 0.1,
        max_tokens: 200,
        frequency_penalty: 1.0,
        presence_penalty: 1.0,
        tools: this.functions,
      });

      for await (const event of events as any) {
        if (event.choices.length >= 1) {
          const delta = event.choices[0].delta;
          if (!delta) continue;

          // Handle tool/function call
          if (delta.tool_calls && delta.tool_calls.length > 0 && !toolCallHandled) {
            const toolCall = delta.tool_calls[0];
            if (toolCall.id && toolCall.function?.name) {
              funcArguments += toolCall.function.arguments || "";
              funcCall = {
                id: toolCall.id,
                funcName: toolCall.function.name,
                arguments: {},
              };
              continue;
            }
          } else if (funcCall && funcArguments && !toolCallHandled) {
            funcCall.arguments = JSON.parse(funcArguments);
            const functionResult = await this.handleFunctionCall(funcCall.funcName, funcCall.arguments);

            let parsedResult: any;
            try {
              parsedResult = JSON.parse(functionResult);
            } catch {
              parsedResult = { error: "Invalid response format" };
            }

            let responseContent = "";
            if (parsedResult.available) {
              responseContent = `Great! ${parsedResult.message || 'That time slot is available.'}`;
              if (parsedResult.suggested_times && Array.isArray(parsedResult.suggested_times) && parsedResult.suggested_times.length > 0) {
                responseContent += ` I also have these alternative times available: ${parsedResult.suggested_times.join(", ")}.`;
              }
            } else if (parsedResult.success && funcCall.funcName === "ghl_lookup") {
              responseContent = parsedResult.message || "Contact information found.";
            } else {
              responseContent = `I'm sorry, that time slot isn't available. Let me suggest some alternatives.`;
              if (parsedResult.suggested_times && Array.isArray(parsedResult.suggested_times) && parsedResult.suggested_times.length > 0) {
                responseContent += ` How about: ${parsedResult.suggested_times.join(", ")}?`;
              }
            }

            const res: CustomLlmResponse = {
              response_type: "response",
              response_id: request.response_id,
              content: responseContent,
              content_complete: true,
              end_call: false,
            };
            ws.send(JSON.stringify(res));
            toolCallHandled = true;
            break;
          } else if (delta.content && !toolCallHandled) {
            const res: CustomLlmResponse = {
              response_type: "response",
              response_id: request.response_id,
              content: delta.content,
              content_complete: false,
              end_call: false,
            };
            ws.send(JSON.stringify(res));
          }
        }
      }
    } catch (err) {
      console.error("Error in gpt stream: ", err);
    } finally {
      if (funcCall && funcCall.funcName === "end_call") {
        const res: CustomLlmResponse = {
          response_type: "response",
          response_id: request.response_id,
          content: "Thank you for calling PestAway Solutions!",
          content_complete: true,
          end_call: true,
        };
        ws.send(JSON.stringify(res));
      }
    }
  }
}
