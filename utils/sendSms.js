// import axios from "axios";
// import https from "https"; // ✅ ADDED NATIVE HTTPS MODULE
// import dotenv from "dotenv";
// dotenv.config();

// // ✅ THE MAGIC FIX: Force Node to use IPv4. 
// // This bypasses the routing bugs causing the 15-second timeouts on local networks.
// const agent = new https.Agent({ family: 4 });

// export const sendSmsOtp = async (phone, code) => {
//   try {
//     // Clean the phone number
//     const cleanPhone = phone.replace('+', '');

//     const response = await axios.post(
//       "https://api.sendchamp.com/api/v1/sms/send",
//       {
//         to: [cleanPhone],
//         message: `Your Keyvia verification code is ${code}. It expires in 10 minutes.`,
//         sender_name: process.env.SENDCHAMP_SENDER_ID,
//         route: "dnd", 
//       },
//       {
//         headers: {
//           "Accept": "application/json",
//           "Content-Type": "application/json",
//           "Authorization": `Bearer ${process.env.SENDCHAMP_KEY}`,
//         },
//         timeout: 15000,
//         httpsAgent: agent // ✅ ATTACH THE IPV4 AGENT HERE
//       }
//     );

//     console.log(`📱 SMS sent successfully to ${cleanPhone}`);
//     return true;

//   } catch (error) {
//     const errorMessage = error.response?.data?.message || error.message;
//     console.error("❌ SendChamp Error:", errorMessage);
    
//     if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
//         console.error("⚠️ STILL TIMING OUT: Try switching your Wi-Fi or turning ON a VPN.");
//     }

//     throw new Error(errorMessage);
//   }
// };



export const sendSmsOtp = async (phone, code) => {
  // ✅ PRO DEV HACK: If we are not in production, just log the code to the terminal
  // This prevents timeouts and saves your SendChamp credits while building!
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\n📲 ================================`);
    console.log(`🚀 MOCK SMS SENT TO: ${phone}`);
    console.log(`🔑 YOUR OTP CODE IS: ${code}`);
    console.log(`================================ 📲\n`);
    return true; // Pretend the API call succeeded
  }

  // 👇 Your original SendChamp fetch logic goes below here 👇
  try {
    const response = await fetch('https://api.sendchamp.com/api/v1/sms/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SENDCHAMP_PUBLIC_KEY}` // or whatever your key is
      },
      body: JSON.stringify({
        // ... your sendchamp payload
      })
    });

    if (!response.ok) {
      throw new Error(`SendChamp API Error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error("❌ SendChamp Error:", error.message);
    throw error;
  }
};