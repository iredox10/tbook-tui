import { loadConfig } from "./config"

export interface AiResponse {
    text: string
    error?: string
}

export async function askAi(prompt: string, contextText: string): Promise<AiResponse> {
    const config = loadConfig()
    
    if (config.aiProvider === "ollama") {
        return askOllama(config.aiModel, config.aiBaseUrl, prompt, contextText)
    } else {
        return askOpenAI(config.aiModel, config.aiApiKey, prompt, contextText)
    }
}

async function askOllama(model: string, baseUrl: string, prompt: string, context: string): Promise<AiResponse> {
    try {
        const url = `${baseUrl.replace(/\/$/, "")}/api/generate`
        const fullPrompt = `${prompt}\n\nText to analyze:\n${context}`
        
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: model,
                prompt: fullPrompt,
                stream: false
            })
        })
        
        if (!res.ok) {
            return { text: "", error: `Ollama API Error: ${res.statusText}` }
        }
        
        const data = await res.json() as any
        return { text: data.response || "" }
    } catch (e: any) {
        return { text: "", error: e.message || String(e) }
    }
}

async function askOpenAI(model: string, apiKey: string, prompt: string, context: string): Promise<AiResponse> {
    if (!apiKey) return { text: "", error: "OpenAI API key is missing. Please set aiApiKey in config." }
    
    try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: "You are a helpful reading assistant. Be concise and insightful." },
                    { role: "user", content: `${prompt}\n\nText:\n${context}` }
                ]
            })
        })
        
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as any
            return { text: "", error: err.error?.message || `OpenAI API Error: ${res.status}` }
        }
        
        const data = await res.json() as any
        return { text: data.choices?.[0]?.message?.content || "" }
    } catch (e: any) {
        return { text: "", error: e.message || String(e) }
    }
}
