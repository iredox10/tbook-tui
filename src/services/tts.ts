import { spawn, type ChildProcess } from "child_process"
import { platform } from "os"

export class TTSService {
    private static currentProcess: ChildProcess | null = null
    private static isSpdSayActive = false

    static play(text: string, onFinish?: () => void, onError?: (err: Error) => void) {
        this.stop()
        
        const os = platform()
        let cmd = ""
        let args: string[] = []

        if (os === "darwin") {
            cmd = "say"
            args = [text]
        } else if (os === "win32") {
            cmd = "powershell"
            args = ["-Command", `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace(/'/g, "''")}')`]
        } else {
            // Linux fallback sequence: espeak, then spd-say
            cmd = "espeak"
            args = [text]
        }

        try {
            this.currentProcess = spawn(cmd, args)
            this.currentProcess.on('error', (err) => {
                if (os !== "darwin" && os !== "win32" && cmd === "espeak") {
                    // Try spd-say -e (pipe to speechd) and -w (wait for finish)
                    this.currentProcess = spawn("spd-say", ["-e", "-w", text])
                    this.isSpdSayActive = true
                    
                    this.currentProcess.on('error', (fallbackErr) => {
                        this.isSpdSayActive = false
                        if (onError) onError(fallbackErr)
                    })
                    this.currentProcess.on('exit', () => {
                        this.isSpdSayActive = false
                        if (onFinish) onFinish()
                    })
                } else {
                    if (onError) onError(err)
                }
            })
            this.currentProcess.on('exit', () => {
                if (onFinish) onFinish()
            })
        } catch (e: any) {
            if (onError) onError(e)
        }
    }

    static stop() {
        if (this.currentProcess) {
            this.currentProcess.kill()
            this.currentProcess = null
        }
        if (this.isSpdSayActive) {
            // spd-say sometimes leaves the daemon speaking even if we kill the spd-say -w process
            try { spawn("spd-say", ["-S"]) } catch {}
            this.isSpdSayActive = false
        }
    }

    static isPlaying(): boolean {
        if (!this.currentProcess) return false
        return this.currentProcess.exitCode === null && !this.currentProcess.killed
    }
}
