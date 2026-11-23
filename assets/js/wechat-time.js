/** 剧情钟：UTC 字段只用于编码虚构日历，storyAt 不代表现实世界的 UTC 时刻。 */
(function () {
    const STEP = 0; // 连发与即时回复沿用同一剧情时刻。
    const pad = value => String(value).padStart(2, '0');
    function parse(value) {
        if (typeof value !== 'string') return null;
        const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
        if (!match) return null;
        const [, y, m, d, h, min, sec = '0'] = match;
        const date = new Date(0);
        date.setUTCFullYear(+y, +m - 1, +d);
        date.setUTCHours(+h, +min, +sec, 0);
        if (+y < 1 || date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1
            || date.getUTCDate() !== +d || date.getUTCHours() !== +h
            || date.getUTCMinutes() !== +min || date.getUTCSeconds() !== +sec) return null;
        return date.getTime();
    }
    const valid = value => typeof value === 'number' && Number.isFinite(value)
        && value >= -62135596800000 && value <= 253402300799999;
    function format(value, seconds = false) {
        if (!valid(value)) return '';
        const date = new Date(value);
        return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
            + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${seconds ? ':' + pad(date.getUTCSeconds()) : ''}`;
    }
    // 旧消息保留原来本机日历上的显示；只在首次进入剧情钟时用它作起点。
    function legacyTime(ts) {
        if (!valid(ts)) return null;
        const date = new Date(ts);
        return parse(`${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`);
    }
    const itemTime = item => valid(item?.storyAt) ? item.storyAt : legacyTime(item?.ts);
    function rpTime(content, reference, origin = reference) {
        // 只读正文首行的当前场景时间。完整公历独立解析，中文和相对日
        // 需要当前分支日历作为参考；不从台词、约定或回忆中取时。
        const first = String(content || '').replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim().split(/\r?\n/)[0];
        const match = first.match(/^【(\d{4})(?:年(\d{1,2})月(\d{1,2})日|-(\d{2})-(\d{2}))\s+(\d{1,2})(?:时(?:(\d{1,2})分)?|:(\d{2}))】$/);
        if (match) return parse(`${match[1]}-${pad(match[2] || match[4])}-${pad(match[3] || match[5])} ${pad(match[6])}:${pad(match[7] || match[8] || 0)}`);
        if (!valid(reference) || /[“"「『]|说[：:]|明天|昨天|曾经|回忆|打算|约定/.test(first)) return null;
        const number = text => {
            if (/^\d+$/.test(text)) return Number(text);
            const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
            if (text.includes('十')) { const [a, b] = text.split('十'); return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0); }
            return digits[text];
        };
        // Partial narrative dates use this branch's fictional calendar, never
        // the wall clock. Vague month periods use a documented calendar anchor.
        const n = '[零〇一二两三四五六七八九十\\d]+';
        const narrative = first.replace(/^【|】$/g, '');
        const clock = new RegExp(`(?:^第${n}日\\s*|^(?:${n}月(?:末|底|初|中旬|下旬|上旬|${n}日)?[，,\\s]*)?)(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)\\s*)?(${n})(?:点|时)(?:(${n})分|(一刻|三刻|半))?`).exec(narrative);
        if (!clock) return null;
        let hour = number(clock[2]), minute = clock[3] ? number(clock[3]) : ({ 一刻: 15, 三刻: 45, 半: 30 }[clock[4]] || 0);
        if (/下午|傍晚|晚上|夜里/.test(clock[1] || '') && hour < 12) hour += 12;
        if (/凌晨|早上|上午/.test(clock[1] || '') && hour === 12) hour = 0;
        const date = new Date(reference);
        const dayIndex = new RegExp(`^第(${n})日`).exec(narrative);
        if (dayIndex && valid(origin)) date.setTime(origin + (number(dayIndex[1]) - 1) * 86400000);
        const month = new RegExp(`^(${n})月(末|底|初|中旬|下旬|上旬|(${n})日)?`).exec(narrative);
        if (month) {
            const m = number(month[1]);
            if (m < 1 || m > 12) return null;
            const lastDay = new Date(Date.UTC(date.getUTCFullYear(), m, 0)).getUTCDate();
            const day = month[3] ? number(month[3]) : /末|底/.test(month[2] || '') ? lastDay
                : ({ 初: 1, 上旬: 5, 中旬: 15, 下旬: 25 }[month[2]] || Math.min(date.getUTCDate(), lastDay));
            return parse(`${date.getUTCFullYear()}-${pad(m)}-${pad(day)} ${pad(hour)}:${pad(minute)}`);
        }
        return parse(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(hour)}:${pad(minute)}`);
    }
    function anchor(timeline, fallback) {
        let time = fallback ?? null, established = false, origin = null;
        for (const item of timeline) {
            if (item.channel === 'rp') {
                const rp = rpTime(item.content, time, origin ?? time);
                if (rp !== null) { time = established ? Math.max(time, rp) : rp; established = true; origin ??= rp; }
                continue;
            }
            if (item.channel !== 'wechat' || !['user', 'assistant'].includes(item.role)) continue;
            const sent = itemTime(item);
            if (sent === null) continue;
            time = valid(item.storyAt) ? sent : established ? Math.max(time, sent) : sent;
            established ||= valid(item.storyAt);
        }
        return { time, established };
    }
    function metadata(item) {
        const result = {};
        if (parse(item.sendAt) !== null) result.sendAt = item.sendAt.trim();
        if (typeof item.delayMinutes === 'number' && Number.isFinite(item.delayMinutes) && item.delayMinutes >= 0) result.delayMinutes = item.delayMinutes;
        return result;
    }
    function resolve(message, previous) {
        const absolute = parse(message.sendAt);
        const delayed = typeof message.delayMinutes === 'number' && Number.isFinite(message.delayMinutes) && message.delayMinutes >= 0
            ? previous + message.delayMinutes * 60000 : null;
        const requested = valid(message.storyAt) ? message.storyAt : absolute ?? delayed;
        return valid(requested) && requested >= previous ? requested : previous + STEP;
    }
    function elapsed(ms) {
        const minutes = Math.floor(ms / 60000);
        if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}秒`;
        const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
        return `${days ? days + '天' : ''}${hours ? hours + '小时' : ''}${rest ? rest + '分钟' : ''}`;
    }
    function annotate(content, time, clock) {
        if (!valid(time) || clock.time === time) return content;
        const gap = valid(clock.time) && time > clock.time ? `｜距上一条 ${elapsed(time - clock.time)}` : '';
        const header = `【发送时间：${format(time, true)}${gap}】`;
        clock.time = time;
        return Array.isArray(content) ? [{ type: 'text', text: header }, ...content] : `${header}\n${content}`;
    }
    const RULE = `【剧情时间与发送时间】
微信使用玩家设定的剧情钟。一个【发送时间】标记适用于其后连续的消息，直到下一个时间标记；连续发送默认视为同一时刻，合并文本只在开头标一次时间。现实日期、网络请求耗时和打字动画不推进剧情。
根据消息间实际的剧情间隔，结合人设、处境和上次沉默原因，判断人物这段时间可能在做什么、情绪是否变化；不要把一小时后的联系当成紧接着的追问，也不要仅因时间过去就编造获救、手机归还或已经完成的重大事件。
每条 messages 元素可选带 sendAt（完整公历日期时间，例 "2023-08-01 19:00:00"）或 delayMinutes（相对上一条实际发送消息的剧情分钟数，例 60）。第一个回复以当前剧情钟为基准，后续回复以本轮上一条为基准；二者同时出现时 sendAt 优先。不指定则紧接上一条，不能倒退时间。
愿意回复但会先冷静一小时，可输出 {"messages":[{"type":"text","content":"刚才有点生气","delayMinutes":60}]}；连续短回复不用逐条设时间。按人物和场景选择，别每轮无故跳时。
发送时间代表该条实际发出时的处境。无法安全通信且没有恢复条件时仍按空回协议处理，不得用未来时间捏造解除限制。messages:[] 不推进剧情钟。
时间字段是内部发送元数据，不要写入气泡正文。程序直接推进剧情并展示消息，不要求玩家在现实中等待。`;
    window.RPHubWeChatTime = Object.freeze({ STEP, parse, valid, format, legacyTime, itemTime, rpTime, anchor, metadata, resolve, elapsed, annotate, RULE });
})();
