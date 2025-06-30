const TelegramBot = require('node-telegram-bot-api')
const axios = require('axios')
const cheerio = require('cheerio')
const fs = require('fs').promises
const path = require('path')

// Конфигурация
const BOT_TOKEN =
	process.env.BOT_TOKEN || '8118312308:AAFB79HimMN01tCPTLQ2nnOHpJfZzg1lv5s'
const CHAT_ID = process.env.CHAT_ID || '1812059915'
const CHECK_INTERVAL = 5 * 60 * 1000 // 5 минут в миллисекундах
const DATA_FILE = 'video_data.json'
const PORT = process.env.PORT || 3000

const AUTHORS = {
	blobcg: 'https://rule34.xyz/blobcg',
	croove: 'https://rule34.xyz/croove',
	giddora: 'https://rule34.xyz/giddora',
	anna_anon: 'https://rule34.xyz/anna_anon',
}

// Создаем экземпляр бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true })

// Простой HTTP сервер для Railway (чтобы сервис не засыпал)
const express = require('express')
const app = express()

app.get('/', (req, res) => {
	res.json({
		status: 'Bot is running',
		uptime: process.uptime(),
		authors: Object.keys(AUTHORS).length,
	})
})

app.get('/health', (req, res) => {
	res.json({ status: 'OK', timestamp: new Date().toISOString() })
})

app.listen(PORT, () => {
	console.log(`HTTP server running on port ${PORT}`)
})

// Хранилище для отслеживания видео
let videoData = {}
let isInitialized = false

// Загрузка сохраненных данных
async function loadVideoData() {
	try {
		const data = await fs.readFile(DATA_FILE, 'utf8')
		const loadedData = JSON.parse(data)
		videoData = loadedData.videoData || {}
		isInitialized = loadedData.isInitialized || false
		console.log('Данные загружены из файла')
		console.log(
			`Состояние инициализации: ${isInitialized ? 'завершена' : 'требуется'}`
		)
	} catch (error) {
		console.log('Файл данных не найден, создаем новый')
		videoData = {}
		isInitialized = false
		for (const author in AUTHORS) {
			videoData[author] = []
		}
		await saveVideoData()
	}
}

// Сохранение данных
async function saveVideoData() {
	try {
		const dataToSave = {
			videoData: videoData,
			isInitialized: isInitialized,
			lastUpdate: new Date().toISOString(),
		}
		await fs.writeFile(DATA_FILE, JSON.stringify(dataToSave, null, 2))
		console.log('Данные сохранены')
	} catch (error) {
		console.error('Ошибка сохранения данных:', error)
	}
}

// Получение последнего поста с страницы автора (по аналогии с Python функцией)
async function getLatestPostUrl(modelUrl) {
	try {
		console.log(`Проверяем страницу: ${modelUrl}`)

		const response = await axios.get(modelUrl, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
			},
			timeout: 10000,
		})

		const $ = cheerio.load(response.data)

		// Ищем контейнер с видео
		const container = $('div.box-grid')
		if (!container.length) {
			console.log('Контейнер box-grid не найден')
			return null
		}

		// Ищем первую ссылку в контейнере
		const firstLink = container.find('a.box').first()
		if (!firstLink.length || !firstLink.attr('href')) {
			console.log('Первая ссылка не найдена')
			return null
		}

		const href = firstLink.attr('href')
		const fullUrl = new URL(href, modelUrl).href
		const postId =
			href.split('/').pop() || Math.random().toString(36).substr(2, 9)

		return {
			url: fullUrl,
			title: fullUrl, // Используем ссылку вместо названия
			id: postId,
		}
	} catch (error) {
		console.error(`Ошибка при получении видео с ${modelUrl}:`, error.message)
		return null
	}
}

let initMessageId = null

// Проверка нового видео для автора
async function checkNewVideos(author, url) {
	const latestPost = await getLatestPostUrl(url)

	if (!latestPost) {
		console.log(`Не удалось получить последний пост для ${author}`)
		return
	}

	// Проверяем, есть ли этот пост в наших данных
	const previousPosts = videoData[author] || []
	const isNewPost = !previousPosts.some(post => post.id === latestPost.id)

	if (isNewPost) {
		// Добавляем новый пост в начало списка
		videoData[author] = [latestPost, ...previousPosts.slice(0, 19)] // Храним только последние 20 постов
		await saveVideoData()

		if (isInitialized) {
			// Отправляем уведомление только если бот уже инициализирован
			console.log(`Найдено новое видео для ${author}: ${latestPost.title}`)
			await sendVideoNotification(author, latestPost)
		} else {
			// При первой инициализации просто собираем данные и обновляем сообщение
			console.log(
				`Инициализация: сохранен пост для ${author}: ${latestPost.title}`
			)
			await updateInitMessage()
		}
	} else {
		console.log(`Новых видео для ${author} не найдено`)
		// Обновляем сообщение инициализации даже если видео не новое
		if (!isInitialized) {
			await updateInitMessage()
		}
	}
}

async function updateInitMessage() {
	if (!initMessageId) return

	try {
		const totalVideos = Object.values(videoData).reduce(
			(sum, posts) => sum + posts.length,
			0
		)
		const processedAuthors = Object.keys(videoData).filter(
			author => videoData[author].length > 0
		).length
		const totalAuthors = Object.keys(AUTHORS).length

		const message =
			`🔄 <b>Инициализация бота...</b>\n\n` +
			`📊 Прогресс: ${processedAuthors}/${totalAuthors} авторов\n` +
			`📺 Найдено видео: ${totalVideos}\n\n` +
			`${
				processedAuthors === totalAuthors
					? '✅ Инициализация завершена!'
					: '⏳ Обработка...'
			}`

		await bot.editMessageText(message, {
			chat_id: CHAT_ID,
			message_id: initMessageId,
			parse_mode: 'HTML',
		})
	} catch (error) {
		console.error('Ошибка обновления сообщения инициализации:', error)
	}
}

// Отправка уведомления о новом видео
async function sendVideoNotification(author, video) {
	const message =
		`🆕 Новое видео от <b>${author}</b>\n\n` +
		`📺 ${video.url}\n\n` + // Просто ссылка без тега <a>
		`👤 Автор: ${author}`

	const keyboard = {
		inline_keyboard: [
			[
				{ text: '✅ Accept', callback_data: `accept_${author}_${video.id}` },
				{ text: '❌ Reject', callback_data: `reject_${author}_${video.id}` },
			],
		],
	}

	try {
		await bot.sendMessage(CHAT_ID, message, {
			parse_mode: 'HTML',
			reply_markup: keyboard,
			disable_web_page_preview: false,
		})
		console.log(`Уведомление отправлено: ${author} - ${video.url}`)
	} catch (error) {
		console.error('Ошибка отправки сообщения:', error)
	}
}

// Обработка нажатий на кнопки
bot.on('callback_query', async callbackQuery => {
	const data = callbackQuery.data
	const messageId = callbackQuery.message.message_id
	const chatId = callbackQuery.message.chat.id

	if (data.startsWith('accept_') || data.startsWith('reject_')) {
		const action = data.startsWith('accept_') ? 'Accept' : 'Reject'
		const actionEmoji = action === 'Accept' ? '✅' : '❌'

		// Получаем исходный текст сообщения
		const originalText = callbackQuery.message.text
		const newText = originalText + `\n\n${actionEmoji} <b>Статус: ${action}</b>`

		try {
			// Редактируем сообщение, убирая кнопки
			await bot.editMessageText(newText, {
				chat_id: chatId,
				message_id: messageId,
				parse_mode: 'HTML',
				disable_web_page_preview: false,
			})

			// Отвечаем на callback query
			await bot.answerCallbackQuery(callbackQuery.id, {
				text: `Выбрано: ${action}`,
			})

			console.log(`Действие выполнено: ${action} для сообщения ${messageId}`)
		} catch (error) {
			console.error('Ошибка обработки callback query:', error)
		}
	}
})

// Основная функция проверки всех авторов
async function checkAllAuthors() {
	if (!isInitialized) {
		console.log('🔄 Выполняется первоначальная инициализация бота...')

		// Отправляем первоначальное сообщение инициализации
		try {
			const initMessage = await bot.sendMessage(
				CHAT_ID,
				'🔄 <b>Инициализация бота...</b>\n\n📊 Прогресс: 0/4 авторов\n📺 Найдено видео: 0\n\n⏳ Обработка...',
				{
					parse_mode: 'HTML',
				}
			)
			initMessageId = initMessage.message_id
		} catch (error) {
			console.error('Ошибка отправки сообщения инициализации:', error)
		}
	} else {
		console.log('Начинаем проверку всех авторов...')
	}

	for (const [author, url] of Object.entries(AUTHORS)) {
		try {
			await checkNewVideos(author, url)
			// Задержка между проверками разных авторов
			await new Promise(resolve => setTimeout(resolve, 2000))
		} catch (error) {
			console.error(`Ошибка при проверке автора ${author}:`, error)
		}
	}

	if (!isInitialized) {
		isInitialized = true
		await saveVideoData()
		console.log('✅ Первоначальная инициализация завершена')

		// Финальное обновление сообщения инициализации
		if (initMessageId) {
			try {
				const totalVideos = Object.values(videoData).reduce(
					(sum, posts) => sum + posts.length,
					0
				)
				const finalMessage =
					`✅ <b>Инициализация завершена!</b>\n\n` +
					`📊 Обработано: ${Object.keys(AUTHORS).length}/${
						Object.keys(AUTHORS).length
					} авторов\n` +
					`📺 Найдено видео: ${totalVideos}\n\n` +
					`🔄 Теперь бот будет проверять новые видео каждые 5 минут`

				await bot.editMessageText(finalMessage, {
					chat_id: CHAT_ID,
					message_id: initMessageId,
					parse_mode: 'HTML',
				})
			} catch (error) {
				console.error('Ошибка финального обновления сообщения:', error)
			}
		}

		// Сбрасываем ID сообщения инициализации
		initMessageId = null
	} else {
		console.log('Проверка завершена')
	}
}

// Команда старт
bot.onText(/\/start/, async msg => {
	if (msg.chat.id.toString() === CHAT_ID) {
		const startMessage = `
🤖 <b>Бот для мониторинга видео запущен!</b>

${
	isInitialized
		? '✅ Бот инициализирован и готов к работе'
		: '⚠️ Требуется инициализация (используйте /check)'
}
🔄 Автоматическая проверка каждые 5 минут
📺 Отслеживаем ${Object.keys(AUTHORS).length} авторов

Доступные команды:
/help - Показать все команды
/check - ${isInitialized ? 'Ручная проверка' : 'Запустить инициализацию'}
/status - Статус бота
/authors - Список авторов
/last_videos - Последние видео
        `

		await bot.sendMessage(CHAT_ID, startMessage, { parse_mode: 'HTML' })
	}
})

// Команда для получения списка авторов
bot.onText(/\/authors/, async msg => {
	if (msg.chat.id.toString() === CHAT_ID) {
		let authorsMessage = '👥 <b>Отслеживаемые авторы:</b>\n\n'

		let index = 1
		for (const [author, url] of Object.entries(AUTHORS)) {
			authorsMessage += `${index}. <b>${author}</b>\n`
			authorsMessage += `   🔗 <a href="${url}">${url}</a>\n\n`
			index++
		}

		await bot.sendMessage(CHAT_ID, authorsMessage, {
			parse_mode: 'HTML',
			disable_web_page_preview: true,
		})
	}
})

// Команда для получения последних видео
bot.onText(/\/last_videos/, async msg => {
	if (msg.chat.id.toString() === CHAT_ID) {
		let lastVideosMessage = '📺 <b>Последние видео авторов:</b>\n\n'

		let hasVideos = false
		for (const [author, posts] of Object.entries(videoData)) {
			if (posts && posts.length > 0) {
				hasVideos = true
				const latestPost = posts[0]
				lastVideosMessage += `👤 <b>${author}</b>\n`
				lastVideosMessage += `📹 ${latestPost.url}\n` // Просто ссылка
				lastVideosMessage += `🆔 ID: ${latestPost.id}\n\n`
			} else {
				lastVideosMessage += `👤 <b>${author}</b>\n`
				lastVideosMessage += `❌ Нет сохраненных видео\n\n`
			}
		}

		if (!hasVideos) {
			lastVideosMessage +=
				'❌ Пока нет сохраненных видео.\nИспользуйте /check для проверки новых видео.'
		}

		await bot.sendMessage(CHAT_ID, lastVideosMessage, {
			parse_mode: 'HTML',
			disable_web_page_preview: false,
		})
	}
})
bot.onText(/\/check/, async msg => {
	if (msg.chat.id.toString() === CHAT_ID) {
		if (isInitialized) {
			await bot.sendMessage(CHAT_ID, '🔍 Запускаю ручную проверку...')
			await checkAllAuthors()
			await bot.sendMessage(CHAT_ID, '✅ Ручная проверка завершена')
		} else {
			// Если бот не инициализирован, запускаем инициализацию
			await checkAllAuthors()
		}
	}
})

// Команда для получения статуса
bot.onText(/\/status/, async msg => {
	if (msg.chat.id.toString() === CHAT_ID) {
		let statusMessage = '📊 <b>Статус бота:</b>\n\n'

		statusMessage += `🔧 <b>Инициализация:</b> ${
			isInitialized ? '✅ Завершена' : '❌ Требуется'
		}\n\n`

		for (const [author, posts] of Object.entries(videoData)) {
			statusMessage += `👤 <b>${author}</b>: ${posts.length} постов отслеживается\n`
			if (posts.length > 0) {
				statusMessage += `   └ Последний: ${posts[0].url}\n` // Показываем ссылку
			}
		}

		statusMessage += `\n🔄 Интервал проверки: ${CHECK_INTERVAL / 60000} минут`
		statusMessage += `\n⏰ Бот проверяет новые видео каждые 5 минут`

		if (!isInitialized) {
			statusMessage += `\n\n⚠️ <b>Внимание:</b> Бот еще не инициализирован. Используйте /check для запуска инициализации.`
		}

		await bot.sendMessage(CHAT_ID, statusMessage, { parse_mode: 'HTML' })
	}
})

// Команда помощи
bot.onText(/\/help/, async msg => {
	if (msg.chat.id.toString() === CHAT_ID) {
		const helpMessage = `
🤖 <b>Команды бота:</b>

/start - Запуск бота и приветствие
/check - Ручная проверка новых видео
/status - Показать статус бота
/authors - Список отслеживаемых авторов
/last_videos - Последние видео каждого автора
/help - Показать это сообщение

📝 <b>Информация:</b>
• Бот автоматически проверяет новые видео каждые 5 минут
• При обнаружении нового видео отправляется уведомление с кнопками Accept/Reject
• Нажатие на кнопку изменяет статус сообщения
• Отслеживается ${Object.keys(AUTHORS).length} авторов
        `

		await bot.sendMessage(CHAT_ID, helpMessage, { parse_mode: 'HTML' })
	}
})

// Инициализация бота
async function initBot() {
	try {
		console.log('Запуск бота...')

		// Загружаем данные
		await loadVideoData()

		// Отправляем сообщение о запуске
		await bot.sendMessage(
			CHAT_ID,
			'🚀 Бот запущен и готов к работе!\n\nИспользуйте /help для просмотра команд.'
		)

		// Запускаем первую проверку через 10 секунд
		setTimeout(checkAllAuthors, 10000)

		// Устанавливаем интервал для периодических проверок только после инициализации
		setInterval(() => {
			if (isInitialized) {
				checkAllAuthors()
			}
		}, CHECK_INTERVAL)

		console.log(
			`Бот успешно запущен. ${
				isInitialized ? 'Проверка каждые 5 минут.' : 'Ожидание инициализации.'
			}`
		)
	} catch (error) {
		console.error('Ошибка при инициализации бота:', error)
	}
}

// Обработка ошибок
process.on('unhandledRejection', error => {
	console.error('Необработанная ошибка Promise:', error)
})

process.on('uncaughtException', error => {
	console.error('Необработанная ошибка:', error)
})

// Запускаем бота
initBot()
